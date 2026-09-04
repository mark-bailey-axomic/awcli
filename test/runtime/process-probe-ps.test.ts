import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What the `ps` adapter does with answers no real `ps` on the developer's machine will give.
 *
 * Stated by what is being staged rather than by a count, because the list grows. A `ps` that does
 * not understand `-o lstart=`; one that times out; one asked under a locale the machine has never
 * been given; one that leaves its stdout held open behind it and then reports *success*, in the two
 * shapes of letting go and never letting go; and the environment awcli hands the child, which is
 * how the locale gets pinned and which binary gets to answer. None of them can be staged with a
 * real `ps`, and most of them decide whether a *live* run's lock survives.
 *
 * So this file substitutes the spawn. It is separate from `process-probe.test.ts` because the module
 * mock is hoisted over the whole file, and that suite's whole value is that it talks to the real
 * operating system.
 */

/** What the substituted `ps` will do on the next call. */
type Response =
  | { readonly kind: "prints"; readonly stdout: string }
  | {
      readonly kind: "fails";
      readonly code: number;
      readonly stderr: string;
      readonly killed?: boolean;
    }
  /**
   * Exits, leaves something holding its stdout, and lets go only after awcli's bound has expired.
   *
   * The settlement node actually produces for that child, which is the finding: not a rejection
   * carrying a kill, but a plain success with whatever had been written so far. Measured on node
   * 22.21.1 under `timeout: 2000` — resolved at 2015ms with `stdout: ""`.
   */
  | { readonly kind: "answers late"; readonly afterMs: number; readonly stdout: string }
  /** Holds its stdout for good, so the callback never arrives at all. */
  | { readonly kind: "never answers" };

let response: Response = { kind: "prints", stdout: "Wed Aug 26 19:52:19 2026" };
let lastEnv: Record<string, string | undefined> | undefined;
/** Every signal awcli sent this child, in order, so the giving-up can be asserted on. */
let signals: string[] = [];
/** Whether awcli destroyed the pipes rather than going on waiting for them. */
let pipesDestroyed = false;
let pending: NodeJS.Timeout | undefined;

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  // The callback form, which is the one `psIdentify` uses: it bounds the call on a clock of awcli's
  // own, and the promisified form gives that clock nothing to work with — no `ChildProcess` to
  // signal and, on the resolve path, no `killed` to read. So the substitute has to be a child and
  // not just a promise: it records the signals it is sent and whether its pipes were destroyed,
  // because those are the observable half of giving up on a bound.
  const fake = (
    _file: string,
    _args: readonly string[],
    options: { readonly env?: Record<string, string | undefined> },
    done: (error: Error | null, stdout: string, stderr: string) => void,
  ): {
    kill(signal: string): boolean;
    readonly stdout: { destroy(): void };
    readonly stderr: { destroy(): void };
  } => {
    lastEnv = options.env;
    if (response.kind === "prints") {
      const printing = response;
      setImmediate(() => done(null, printing.stdout, ""));
    } else if (response.kind === "fails") {
      const failure = response;
      setImmediate(() =>
        done(
          Object.assign(new Error("ps exited non-zero"), {
            code: failure.code,
            killed: failure.killed ?? false,
          }),
          "",
          failure.stderr,
        ),
      );
    } else if (response.kind === "answers late") {
      const late = response;
      pending = setTimeout(() => done(null, late.stdout, ""), late.afterMs);
    }
    return {
      // False, and `killed` never set, because that is what the operating system says when the
      // signal lands on a process that has already exited — measured, and the reason awcli keeps
      // the flag itself.
      kill: (signal: string) => {
        signals.push(signal);
        return false;
      },
      stdout: {
        destroy: () => {
          pipesDestroyed = true;
        },
      },
      stderr: { destroy: () => undefined },
    };
  };
  return { ...real, execFile: fake };
});

const { psIdentify } = await import("../../src/runtime/process-probe.js");

afterEach(() => {
  clearTimeout(pending);
  pending = undefined;
  response = { kind: "prints", stdout: "Wed Aug 26 19:52:19 2026" };
  lastEnv = undefined;
  signals = [];
  pipesDestroyed = false;
});

describe("what ps said, and what it means", () => {
  /**
   * The pin on the locale, checked without needing the machine to have the locale installed. The
   * real-locale test in `process-probe.test.ts` skips itself where fr_FR is not present, which is
   * most of CI — so this is the one that makes removing the pin fail everywhere.
   */
  it("pins the locale for the question regardless of the caller's environment", async () => {
    const previous = process.env["LC_ALL"];
    process.env["LC_ALL"] = "fr_FR.UTF-8";
    try {
      await psIdentify(1234);
    } finally {
      if (previous === undefined) delete process.env["LC_ALL"];
      else process.env["LC_ALL"] = previous;
    }
    expect(lastEnv?.["LC_ALL"]).toBe("C");
  });

  it("reads an exit of 1 with nothing on stderr as 'no process holds that id'", async () => {
    response = { kind: "fails", code: 1, stderr: "" };
    expect(await psIdentify(1234)).toEqual({ kind: "not-found" });
  });

  /**
   * The fail-open case review found. busybox's `ps` — the one in a great many container images —
   * does not take `-o lstart=` and exits 1 saying so. Reading that status alone as "no such
   * process" would evict a *live* owner's lock on every single ask, everywhere that image runs.
   */
  it("does not read an exit of 1 with a complaint on stderr as 'no process'", async () => {
    response = { kind: "fails", code: 1, stderr: "ps: unrecognized option: o\n" };
    const answer = await psIdentify(1234);
    expect(answer.kind).toBe("unknown");
    if (answer.kind !== "unknown") return;
    expect(answer.reason).toContain("unrecognized option");
  });

  it("reads a timeout as 'could not ask', never as 'gone'", async () => {
    response = { kind: "fails", code: 1, stderr: "", killed: true };
    const answer = await psIdentify(1234);
    expect(answer.kind).toBe("unknown");
    if (answer.kind !== "unknown") return;
    expect(answer.reason).toMatch(/did not answer/);
  });

  /**
   * The bound expiring on a child that then reports success, which is where the bound stopped being
   * an answer.
   *
   * The shape: `ps` — or, far likelier, the wrapper script a hardened image has put in front of it —
   * writes nothing yet, hands its stdout to something that outlives it, and exits. The pipe stays
   * open, so `execFile` has nothing to report; the bound expires with the child already gone; and
   * the settlement, when it comes, is a *success*. Measured on node 22.21.1 with
   * `promisify(execFile)` and `timeout: 2000`: resolved at 2015ms with `stdout: ""`, the later write
   * lost. node's own timeout destroys the pipes, the exited child then reports code 0 and signal
   * null, and the `killed` flag execFile keeps for itself is never consulted once the code is 0.
   *
   * Why that is the worst available outcome rather than merely a wrong one. Empty stdout is
   * `not-found`, `not-found` is `gone`, and `gone` evicts a live run's lock — so the bound written so
   * that a slow machine costs a refusal and never a reclamation was producing a reclamation, on
   * exactly the loaded machine it was written for. The assertion is therefore on the *answer* and not
   * only on the sentence: `not-found` here is the whole defect.
   *
   * `psIdentify` is passed a 50ms bound so the case does not cost `PS_TIMEOUT_MS` to stage, and the
   * sentence names that bound rather than the constant.
   */
  it("calls a bound it had to enforce 'could not ask', even when execFile reports success", async () => {
    response = { kind: "answers late", afterMs: 120, stdout: "" };
    const answer = await psIdentify(1234, 50);
    expect(answer.kind).toBe("unknown");
    if (answer.kind !== "unknown") return;
    expect(answer.reason).toBe("ps did not answer within 50ms");
    // SIGTERM first, and only that, because this child let go inside the grace period.
    expect(signals).toEqual(["SIGTERM"]);
    expect(pipesDestroyed).toBe(false);
  });

  /**
   * The same shape with a child that never lets go, which is the other half of the same fix.
   *
   * node's own `timeout` option was what destroyed the pipes; awcli taking the clock over means
   * awcli has to. Without that, a held pipe is a settlement that never arrives, and waiting for it
   * inside the call's own bound turns a bounded question into an unbounded wait on the startup path
   * — a worse version of the failure `PS_TIMEOUT_MS` exists to prevent. So giving up gets a bound of
   * its own: SIGTERM, `PS_CLEANUP_TIMEOUT_MS` of grace, then the pipes go, SIGKILL goes, and the
   * fault is raised whether or not anything ever answered.
   *
   * The elapsed time is asserted as well as the answer, because the answer alone cannot tell a
   * bounded wait from an unbounded one — and an unbounded one is what a mutation to this would
   * produce.
   */
  it("gives up on a child that never lets go, within a bound of its own", async () => {
    response = { kind: "never answers" };
    const started = Date.now();
    const answer = await psIdentify(1234, 50);
    const elapsed = Date.now() - started;

    expect(answer.kind).toBe("unknown");
    if (answer.kind !== "unknown") return;
    expect(answer.reason).toBe("ps did not answer within 50ms");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(pipesDestroyed).toBe(true);
    // The bound plus the grace is 1050ms; the grace derived from the call's bound instead of its own
    // — the plausible mistake — would be 2050ms. 1500ms sits between them, so this is an assertion
    // about which bound was used and not just about the clock. Nothing settles this child at all, so
    // a cleanup with no bound would reach vitest's own 5s timeout rather than any of that.
    expect(elapsed).toBeLessThan(1_500);
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  /**
   * PATH, asserted on the environment the child is handed, entry by entry.
   *
   * `execvp` resolves the bare name `ps` relative to the working directory, so an empty entry and a
   * relative one are both a way for that directory to decide which binary answers — and a plant that
   * exits 0 saying nothing is read as `not-found`, which evicts a live run's lock. The end-to-end
   * proof is in `process-probe.test.ts`, where a `ps` is planted in a real directory; this is the
   * half that holds on every platform and pins the *shape* of the repair, so that narrowing PATH to
   * the empty string — which is a PATH of one entry, the working directory — could not pass here.
   */
  it("hands the child no PATH entry that resolves out of the working directory", async () => {
    const previous = process.env["PATH"];
    process.env["PATH"] = ":/usr/bin:.:/bin:..:relative:/opt/tools:";
    try {
      await psIdentify(1234);
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
    }
    expect(lastEnv?.["PATH"]).toBe("/usr/bin:/bin:/opt/tools");
  });

  /** And when nothing absolute is left, the variable is gone rather than empty. */
  it("removes PATH rather than emptying it when no absolute entry survives", async () => {
    const previous = process.env["PATH"];
    process.env["PATH"] = ".:..:relative:";
    try {
      await psIdentify(1234);
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
    }
    expect(lastEnv).toBeDefined();
    expect(lastEnv && "PATH" in lastEnv).toBe(false);
  });

  it("reads an unparseable time as 'could not ask', never as 'gone'", async () => {
    response = { kind: "prints", stdout: "mer. 26 aout 19:52:19 2026" };
    expect((await psIdentify(1234)).kind).toBe("unknown");
  });

  /**
   * The reason is another program's stderr, and it reaches a terminal two ways: through a refusal,
   * and through the throw in `self()` when awcli cannot identify itself. One consumer sanitised it
   * and the other did not, which is an argument for doing it here — at the point the foreign string
   * enters awcli — rather than at each place it leaves.
   */
  it("does not carry what a terminal would act on out of ps's own output", async () => {
    response = {
      kind: "fails",
      code: 1,
      stderr: "ps: \u001b[2Junrecognized \u202eoption: o\n",
    };
    const answer = await psIdentify(1234);
    expect(answer.kind).toBe("unknown");
    if (answer.kind !== "unknown") return;
    expect(answer.reason).not.toContain("\u001b");
    expect(answer.reason).not.toContain("\u202e");
    expect(answer.reason).toContain("unrecognized");
  });

  /** And it does not carry a megabyte of it either: a refusal has its own explanation to deliver. */
  it("caps how much of a complaint a reason carries", async () => {
    response = { kind: "fails", code: 1, stderr: `ps: ${"x".repeat(5_000)}\n` };
    const answer = await psIdentify(1234);
    expect(answer.kind).toBe("unknown");
    if (answer.kind !== "unknown") return;
    expect(answer.reason.length).toBeLessThan(200);
  });
});
