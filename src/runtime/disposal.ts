/**
 * The disposal stack: one owned mechanism that every releasable resource registers with, and
 * that unwinds in reverse on every exit path.
 *
 * This is the acknowledged weak point of a framework-free design (ADR-0001). An effect runtime
 * would supply scoped cleanup; plain TypeScript does not, so it is hand-written — and therefore
 * built and tested before anything registers with it (WB-2), rather than as a convention
 * repeated at each call site. A run acquires a lock, worktrees, containers and child processes;
 * any of those outliving a failed run blocks the next one with a lock nobody holds.
 *
 * Two properties do most of the work, and both are structural rather than documented:
 *
 *   - Acquiring and registering are the same call. `acquire` takes the function that opens the
 *     resource, so there is no moment where a resource exists and the stack does not know about
 *     it, and no call site that can be written correctly except by going through here.
 *   - Unwinding never throws. It runs on paths that are already failing, and an exception from
 *     cleanup would replace the operator's real error with a cleanup error. Failures come back
 *     as a report instead — all of them, not the first.
 */

/**
 * Whether releasing a resource destroys what it holds.
 *
 * Fixed when the resource is acquired, not chosen at unwind time, because BR-021 states it per
 * resource and not per exit path: the run lock is always released, and worktrees are always
 * preserved so an interrupted run's work is still on disk to inspect. Recording it here is what
 * lets a test assert that property against the unwind report rather than against a comment.
 */
export type Disposition = "destroy" | "preserve";

/**
 * How a release failed.
 *
 * `abandoned` is the interesting one: the release was invoked and never came back, so what it
 * holds may or may not have been let go. It is reported as a failure rather than a success for
 * exactly that reason — nobody knows, and a leak nobody knows about is the failure mode this
 * whole unit exists to prevent.
 *
 * `stranded` is the same admission one step earlier: an acquisition was still opening when the
 * unwind gave up waiting for it. There may be a lock file or a container behind it and there is
 * no handle with which to release it. That is strictly worse than an abandoned release, and the
 * one thing it must never do is go unmentioned.
 */
export type ReleaseFailureReason = "threw" | "abandoned" | "stranded";

export interface ReleaseFailure {
  /** The resource's name, as given at acquisition. */
  readonly name: string;
  readonly reason: ReleaseFailureReason;
  /** The error thrown, or for `abandoned` and `stranded` the wait that elapsed. */
  readonly cause: unknown;
}

export interface ReleasedResource {
  readonly name: string;
  readonly disposition: Disposition;
}

/**
 * What an unwind did, in the order it did it.
 *
 * Returned rather than thrown: see the note on the stack itself. A caller that wants an
 * exception can raise one from `failures`; a caller unwinding after its own failure — which is
 * most of them — wants to report both and does not want cleanup to hijack the exit.
 */
export interface UnwindReport {
  /** True when every registered resource was released without failing. */
  readonly ok: boolean;
  /** Reverse order of acquisition — the order they were actually released in. */
  readonly released: readonly ReleasedResource[];
  /** Every failure, not just the first: unwinding continues past a failing release. */
  readonly failures: readonly ReleaseFailure[];
}

export interface Acquisition<T> {
  /** Operator-facing name, used in reports. `run lock`, not `lock1`. */
  readonly name: string;
  /**
   * Opens the resource. Called by the stack so that opening and registering cannot come apart:
   * a resource that exists is a resource the stack knows how to release.
   */
  readonly open: () => T | Promise<T>;
  /**
   * Lets the resource go. Receives the disposition so an adapter can honour it — a worktree
   * handle's `release(preserve)` is the case this exists for.
   */
  readonly release: (resource: T, disposition: Disposition) => void | Promise<void>;
  /** Defaults to `destroy`. Say `preserve` for anything holding work worth keeping. */
  readonly disposition?: Disposition;
}

export interface DisposalOptions {
  /**
   * How long a single release may take before it is abandoned.
   *
   * The unwind is sequential — reverse order is only meaningful if it is — so the whole
   * unwind is bounded by this times the number of resources held, which is small and finite.
   * That is the bound; there is deliberately no second, whole-unwind deadline, because cutting
   * an unwind short partway would leak the resources it had not reached yet, which is worse
   * than waiting.
   */
  readonly releaseTimeoutMs?: number;
}

/** Ten seconds: long enough for `docker rm` on a loaded machine, short enough to not read as a hang. */
const DEFAULT_RELEASE_TIMEOUT_MS = 10_000;

/** Thrown when something tries to acquire a resource on a stack that is already unwinding. */
export class DisposalClosedError extends Error {
  constructor(readonly resourceName: string) {
    super(
      `Cannot acquire "${resourceName}": the disposal stack is unwinding. Nothing may be acquired once a run has begun to release what it holds.`,
    );
    this.name = "DisposalClosedError";
  }
}

/**
 * Where a resource is between being asked for and being let go.
 *
 * One ledger, deliberately. An earlier version of this kept stranded acquisitions in a separate
 * list from the entries, and review found both bugs that follow from that: a resource whose
 * `open` landed late was never released because it was in neither ledger's plan, and one that
 * *was* released stayed on the stranded list for ever, so `leaks()` reported it long after it
 * had gone. Two ledgers have to be reconciled; one does not.
 */
type EntryState =
  /** `open` has been called and has not come back. */
  | "opening"
  /** The resource exists and is registered. */
  | "held"
  /** Let go, and known to be let go. Everything else on this list is a leak. */
  | "released"
  /** Its release threw. */
  | "failed"
  /** Its release was invoked and never came back. */
  | "abandoned"
  /** Still opening when the unwind stopped waiting. May yet arrive — see `acquire`. */
  | "stranded";

interface Entry {
  readonly name: string;
  readonly disposition: Disposition;
  /**
   * Set once `open` returns. Until then it is a function that reports the invariant break
   * rather than a hole in the type: only a `held` entry is ever released, and a bug in that
   * gating should surface as a named failure in the report and not as a crash out of the
   * unwind, which is the one thing this class promises never to do.
   */
  run: () => void | Promise<void>;
  /** Settles when `open` has returned or thrown. What the unwind waits on. */
  readonly settled: Promise<void>;
  state: EntryState;
}

export class DisposalStack {
  readonly #entries: Entry[] = [];
  /** Entries whose `open` has started and not yet returned. See `acquire` and `unwind`. */
  readonly #opening = new Set<Entry>();
  readonly #releaseTimeoutMs: number;
  /**
   * Set synchronously by `unwind`, before any await.
   *
   * Distinct from `#unwinding` on purpose. `#unwinding ??= this.#unwindOnce()` only assigns
   * after the call returns — which is after `#unwindOnce` has run to its first await — so the
   * promise is not a reliable answer to "is this stack closed?" from inside the unwind itself.
   * A boolean set before anything can yield is.
   */
  #closed = false;
  /** True once the unwind loop has finished. A resource arriving after this has nobody left to release it. */
  #unwound = false;
  #unwinding: Promise<UnwindReport> | undefined;

  constructor(options: DisposalOptions = {}) {
    this.#releaseTimeoutMs = options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
  }

  /**
   * Opens a resource and registers its release, as one step, and answers with the resource.
   *
   * Refuses once unwinding has started — before calling `open`, so a refusal never opens
   * something nobody will close.
   *
   * The awkward case is the one in the middle: an `open` already in flight when the unwind
   * begins. The resource becomes real after the decision to shut down, and it is a real
   * resource either way, so it is registered exactly as any other would be and the unwind
   * releases it in order. That is why the acquisition is announced in `#opening` before `open`
   * is called rather than after it returns: the unwind waits on that set, so an in-flight
   * acquisition is something it knows to wait for instead of something it races.
   *
   * The caller still gets a refusal. It just gets one it does not have to clean up after.
   */
  async acquire<T>(acquisition: Acquisition<T>): Promise<T> {
    if (this.#closed) throw new DisposalClosedError(acquisition.name);

    // The entry exists before `open` is called, so the stack's own list is the record of what is
    // in flight, in acquisition order, from the first moment there is anything to record.
    let registered!: () => void;
    const entry: Entry = {
      name: acquisition.name,
      disposition: acquisition.disposition ?? "destroy",
      run: () => {
        throw new Error(
          `internal: "${acquisition.name}" was released before it finished opening`,
        );
      },
      settled: new Promise<void>((resolve) => {
        registered = resolve;
      }),
      state: "opening",
    };
    this.#entries.push(entry);
    this.#opening.add(entry);

    let resource: T;
    try {
      resource = await acquisition.open();
      // Before the `finally` below, and that ordering is the whole point: the unwind resumes on
      // `settled`, and must find a `held` entry rather than one still marked `opening`.
      entry.run = () => acquisition.release(resource, entry.disposition);
      entry.state = "held";
    } catch (error) {
      // Nothing was acquired, so there is nothing to release and nothing to report. Dropping the
      // entry is what keeps a failed acquisition out of `leaks()`.
      this.#entries.splice(this.#entries.indexOf(entry), 1);
      throw error;
    } finally {
      this.#opening.delete(entry);
      registered();
    }

    if (!this.#closed) return resource;

    // Past the point of no return, and which of the two applies is a matter of milliseconds.
    // If the unwind is still draining it will find this entry — including one it has already
    // given up on and reported as stranded, which is then withdrawn from the report. If it has
    // finished, nobody else is coming, so release it here.
    if (this.#unwound) await this.#release(entry);
    throw new DisposalClosedError(acquisition.name);
  }

  /**
   * Everything acquired and not successfully released.
   *
   * This is the leak check. It counts a release that threw or was abandoned as still held,
   * because in both cases nobody knows whether the resource was let go — and a stack that was
   * never unwound at all reports every resource on it. A test asserting this is empty is what
   * turns a leak into a red suite instead of a lock file found in production next Tuesday.
   */
  leaks(): readonly string[] {
    return this.#entries
      .filter((entry) => entry.state !== "released")
      .map((entry) => entry.name);
  }

  /** Names still held, in acquisition order. Distinct from `leaks` in that it is not a verdict. */
  get held(): readonly string[] {
    return this.#entries
      .filter((entry) => entry.state === "held")
      .map((entry) => entry.name);
  }

  /**
   * Releases everything in reverse order of acquisition, and reports what happened.
   *
   * Idempotent, and safe to call concurrently: the second caller awaits the first unwind rather
   * than starting a second one. That matters more than it looks — AWCLI-04 will call this from a
   * signal handler, which can fire while the body is already unwinding normally, and releasing a
   * container twice is how you turn an interrupt into a crash.
   */
  unwind(): Promise<UnwindReport> {
    this.#closed = true;
    this.#unwinding ??= this.#unwindOnce();
    return this.#unwinding;
  }

  async #unwindOnce(): Promise<UnwindReport> {
    const released: ReleasedResource[] = [];
    const failures: ReleaseFailure[] = [];

    // Wait for acquisitions already in flight to finish registering, so what follows covers the
    // whole stack and not the part of it that happened to have arrived. Without this, a resource
    // whose `open` was still running would be released — if at all — after the caller had been
    // told cleanup was complete, and would appear in no report.
    //
    // Bounded like a release is, and for the same reason: an `open` that never returns must not
    // hold the exit open. One that outlasts the bound is reported as stranded, because there is
    // no handle with which to release it and nothing better to say than so.
    const strandedFailures = new Map<Entry, ReleaseFailure>();
    for (const entry of await this.#awaitOpening()) {
      entry.state = "stranded";
      const failure: ReleaseFailure = {
        name: entry.name,
        reason: "stranded",
        cause: new Error(
          `was still being acquired ${this.#releaseTimeoutMs}ms after the unwind began`,
        ),
      };
      strandedFailures.set(entry, failure);
      failures.push(failure);
    }

    // Drained rather than iterated over a snapshot. An acquisition can still land while this
    // runs — including one just given up on — and a snapshot taken here would not contain it, so
    // it would be released by nobody. Re-reading each time means "reverse order" keeps meaning
    // the most recently acquired resource *that is currently holdable*, which is the only
    // reading of it that survives a late arrival.
    //
    // It terminates: nothing new can be acquired once the stack is closed, so the only entries
    // that can appear are the finitely many that were already opening.
    for (;;) {
      const entry = this.#lastHeld();
      if (entry === undefined) break;

      const failure = await this.#release(entry);

      // It arrived after all. Whatever happened to it now is the truth, so withdraw the guess.
      const stranded = strandedFailures.get(entry);
      if (stranded !== undefined) {
        failures.splice(failures.indexOf(stranded), 1);
        strandedFailures.delete(entry);
      }

      // No early exit. The first failure is the one that would hide the rest, and the rest are
      // exactly the resources someone has to go and clean up by hand.
      if (failure === undefined)
        released.push({ name: entry.name, disposition: entry.disposition });
      else failures.push(failure);
    }

    // Nothing may come between the last scan above and this line. A resource landing in that gap
    // would be released by neither the drain (which has stopped looking) nor `acquire` (which
    // defers to the drain while this is false), so the gap has to stay free of awaits.
    this.#unwound = true;
    return { ok: failures.length === 0, released, failures };
  }

  /** The most recently acquired entry that is currently holdable, or nothing. */
  #lastHeld(): Entry | undefined {
    for (let index = this.#entries.length - 1; index >= 0; index--) {
      const entry = this.#entries[index];
      if (entry?.state === "held") return entry;
    }
    return undefined;
  }

  /**
   * Waits for every in-flight acquisition to register, and answers with those that did not do
   * so in time.
   */
  async #awaitOpening(): Promise<readonly Entry[]> {
    const waiting = [...this.#opening];
    if (waiting.length === 0) return [];

    const registered = Promise.all(waiting.map((entry) => entry.settled)).then(
      () => true as const,
    );
    const gaveUp = new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), this.#releaseTimeoutMs);
      timer.unref?.();
      // Nothing to clear: the winner is decided below and this timer cannot keep the process
      // alive. Clearing it would need a handle threaded out of the executor for no gain.
    });

    if (await Promise.race([registered, gaveUp])) return [];
    // Only the ones still outstanding. Some of the batch will have landed while we waited, and
    // those are `held` now and belong in the drain proper, not in this list.
    return [...this.#opening];
  }

  /** Runs one release under the time bound. Never throws; answers with the failure instead. */
  async #release(entry: Entry): Promise<ReleaseFailure | undefined> {
    const timeoutMs = this.#releaseTimeoutMs;

    // Two-argument `then` rather than a try/catch around the await: it means the release's
    // rejection is handled the moment it is created, so a release that rejects long after it was
    // abandoned still has a handler and cannot surface as an unhandled rejection. `Promise.resolve`
    // wraps it so a release that throws synchronously arrives here too, and not out of this method.
    const attempt = Promise.resolve()
      .then(() => entry.run())
      .then(
        () => ({ reason: undefined }) as const,
        (cause: unknown) => ({ reason: "threw", cause }) as const,
      );

    let timer: NodeJS.Timeout | undefined;
    const abandonment = new Promise<{ reason: "abandoned"; cause: unknown }>(
      (resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              reason: "abandoned",
              cause: new Error(`did not return within ${timeoutMs}ms`),
            }),
          timeoutMs,
        );
        // An abandoned release's timer must not be what keeps the process alive at exit.
        timer.unref?.();
      },
    );

    try {
      const outcome = await Promise.race([attempt, abandonment]);
      if (outcome.reason === undefined) {
        entry.state = "released";
        return undefined;
      }
      entry.state = outcome.reason === "threw" ? "failed" : "abandoned";
      return { name: entry.name, reason: outcome.reason, cause: outcome.cause };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** What a disposal-scoped body produced, alongside what its unwind did. */
export interface DisposalOutcome<T> {
  readonly result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };
  readonly unwind: UnwindReport;
}

/**
 * Runs a body with a disposal stack, and unwinds on the way out however it leaves.
 *
 * The single place cleanup is wired to an exit path, so no call site has to remember to do it —
 * which is the whole point of ADR-0001's note that this must be a mechanism rather than a
 * convention. Normal return, a returned failure, and a throw from the body all unwind here.
 *
 * It does not rethrow. A caller needs both halves to report honestly: the operator's error, and
 * what could not be cleaned up afterwards. Rethrowing would force one of the two to be dropped,
 * and cleanup is the half that would go.
 */
export async function withDisposal<T>(
  body: (stack: DisposalStack) => T | Promise<T>,
  options: DisposalOptions = {},
): Promise<DisposalOutcome<T>> {
  const stack = new DisposalStack(options);
  let result: DisposalOutcome<T>["result"];
  try {
    result = { ok: true, value: await body(stack) };
  } catch (error) {
    result = { ok: false, error };
  }
  return { result, unwind: await stack.unwind() };
}
