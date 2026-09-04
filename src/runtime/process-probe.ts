import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { printable } from "./printable.js";

/**
 * Who holds something, in a form that survives the death of the process that recorded it.
 *
 * A process id alone does not survive it. Ids are recycled — on Linux by default after 32768
 * more processes, which a busy machine reaches in minutes — so a lock recording only a pid says
 * "some process, maybe mine, maybe an unrelated editor that started this afternoon". Pairing the
 * id with the moment the OS says that process started makes the pair unique in practice: a
 * recycled id belongs to a process that started later, so the pair no longer matches and the
 * lock reads as what it is, abandoned.
 *
 * The start time comes from the operating system, never from the process itself. A process
 * reporting its own start time cannot answer for the process that used its id before it.
 */
export interface ProcessIdentity {
  readonly pid: number;
  /**
   * Milliseconds since the epoch, as the OS reports the process's start.
   *
   * Second granularity on both platforms, and that is enough: the comparison is against a value
   * recorded by an earlier process, and for it to collide the recycled id would have to land in
   * the same second as the original's start.
   */
  readonly startedAt: number;
}

/**
 * What the operating system said, including the case where it did not say anything.
 *
 * The third variant is the one that matters, and leaving it out is a fail-open bug rather than a
 * simplification. An earlier version of this file answered `undefined` for both "no process holds
 * that id" and "the question could not be asked", so a `ps` that timed out on a loaded machine,
 * an `EAGAIN` from `fork`, or a container image without `ps` in it all evicted a *live* owner's
 * lock. That failure is load-correlated: it fires when the machine is busy, which is exactly when
 * a second run is most likely to be present for it to collide with.
 *
 * So "I could not find out" is its own answer, and the lock refuses on it rather than reclaiming.
 * A refusal costs the operator a retry; a wrong reclamation costs them the corruption the lock
 * exists to prevent.
 */
export type ProbeAnswer =
  | { readonly kind: "running"; readonly identity: ProcessIdentity }
  /** Asked, and nothing holds that id. */
  | { readonly kind: "not-found" }
  /** Could not ask, or could not understand the answer. Never treated as "gone". */
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Asking the operating system who a process is.
 *
 * A port, because every liveness decision in the lock goes through it and none of them can be
 * staged with real processes: a test needs a process that is alive, one that is gone, one whose id
 * now belongs to something *else*, and one the OS will not answer about. The third cannot be
 * staged at all. So the decision logic is tested against a substitute, and the adapter below is
 * tested against real processes.
 *
 * Asynchronous because the real implementation spawns `ps`, and doing that synchronously blocks
 * the event loop for the whole spawn — on the startup path, with a signal handler installed, that
 * is a window in which Ctrl-C cannot be delivered. It also gives the lock's tests a way to hold a
 * probe open and interleave two acquisitions deterministically, which is how the concurrency
 * tests in `run-lock.test.ts` reproduce a race rather than hoping to hit it.
 */
export interface ProcessProbe {
  /** This process's identity, obtained the same way as any other's — see `systemProcessProbe`. */
  self(): Promise<ProcessIdentity>;
  identify(pid: number): Promise<ProbeAnswer>;
}

/**
 * The lock's own view of a process id it did not record.
 *
 * `gone` and `different` are kept apart because the operator-facing explanation differs: one is
 * "the process that held this is no longer running", the other is "that id belongs to something
 * else now". Both are stale. `undecidable` is neither, and is the reason this is not a boolean.
 */
export type Liveness = "live" | "gone" | "different" | "undecidable";

/**
 * What was decided about a recorded owner, and — when nothing could be — why not.
 *
 * The reason is carried rather than dropped, because it is the whole diagnosis. `undecidable` on
 * its own produces a refusal nobody can act on: "whether process 4242 is still running could not be
 * established" reads the same whether `ps` is missing from the container image, a hardened
 * `hidepid` is hiding the process table, or the machine was merely too loaded to answer within two
 * seconds — and only the first of those will still be true tomorrow. Review caught the reason being
 * thrown away here after the probe had gone to the trouble of writing it.
 */
export interface LivenessVerdict {
  readonly liveness: Liveness;
  /**
   * Why the question could not be answered, when there is anything to say.
   *
   * Present when the probe was asked and answered `unknown`; absent when the verdict was reached
   * without asking, which is what happens to a lock written on another machine — there is no reason
   * to give beyond the host, and the caller has that already. The doc here first said "present
   * exactly when `liveness` is `undecidable`", which two construction sites in `run-lock.ts` break
   * by building that verdict by hand for exactly that case. Stating the invariant the flat interface
   * can actually keep, rather than one a consumer would trust and be wrong about.
   */
  readonly reason: string | undefined;
}

/** Whether the process recorded in `owner` is still the process running under that id. */
export async function livenessOf(
  owner: ProcessIdentity,
  probe: ProcessProbe,
): Promise<LivenessVerdict> {
  const answer = await probe.identify(owner.pid);
  if (answer.kind === "unknown") {
    return { liveness: "undecidable", reason: answer.reason };
  }
  if (answer.kind === "not-found") return { liveness: "gone", reason: undefined };
  return {
    liveness: answer.identity.startedAt === owner.startedAt ? "live" : "different",
    reason: undefined,
  };
}

/**
 * How long `ps` may take before we treat the question as unanswered.
 *
 * Short on purpose: this runs on the startup path, before anything has happened, and a `ps` that
 * hangs must not be the reason a run never begins. Timing out is reported as `unknown` rather than
 * as `not-found`, so a slow machine costs a refusal and never a reclamation.
 *
 * The bound on the *question*, which is a different bound from the one `PS_CLEANUP_TIMEOUT_MS` puts
 * on giving up once this has expired. Enforced by a clock of awcli's own rather than by `execFile`'s
 * `timeout` option, and `runPsBounded` is where that is argued: the option ends the call without
 * saying that it did, so what came back was a truncated answer being read as `ps`'s answer.
 */
const PS_TIMEOUT_MS = 2_000;

/**
 * How long awcli waits for a `ps` it has just given up on to let go of its pipes.
 *
 * A second bound, because the first cannot clean up after itself. Once `PS_TIMEOUT_MS` expires awcli
 * sends SIGTERM and then still has to see the child's stdout and stderr close before `execFile` will
 * call back at all — and node's own `timeout` option, which awcli no longer uses, was what destroyed
 * those pipes. Taking the clock over means taking that over too, or a `ps` whose pipe something else
 * is holding turns a bounded question into an unbounded wait on the startup path: the failure
 * `PS_TIMEOUT_MS` exists to prevent, reintroduced by the fix to a different failure.
 *
 * What it buys is a ceiling on the whole ask — `PS_TIMEOUT_MS` plus this, and nothing past it —
 * rather than a ceiling on the part of the ask awcli can see the end of.
 *
 * A grace period rather than a working allowance, so it is short: a `ps` that will die on SIGTERM
 * dies in milliseconds, and anything still holding the pipes after a second is not something awcli
 * is going to wait out on the way to taking a lock. Deliberately not derived from the bound on the
 * question — the cleanup is not proportional to the work, and a short bound passed for a test needs
 * the same grace as the real one.
 */
const PS_CLEANUP_TIMEOUT_MS = 1_000;

/**
 * How much of `ps`'s complaint a reason carries.
 *
 * Longer than the default for a hostname, because the useful part of "unrecognized option -- o" is
 * the whole sentence, and shorter than a program can print: this ends up inside a refusal that has
 * its own explanation to deliver.
 */
const COMPLAINT_LIMIT = 120;

/**
 * One past the largest number any supported OS hands out as a process id.
 *
 * Linux's `PID_MAX_LIMIT`, 2^22, which bounds `pid_max`, which is itself an *exclusive* bound on
 * what gets allocated — so the largest issuable id is 4194303 and the comparison below is strict.
 * macOS stays far below either. Deliberately a constant rather than a read of
 * `/proc/sys/kernel/pid_max`, which an administrator can lower: a lock recording a pid above the
 * *current* limit is still junk, and reading the limit would make the answer depend on a setting
 * that can change between the write and the read. The exclusivity matters only because this comment
 * is the whole justification for not reading it.
 */
const PID_CEILING = 2 ** 22;

/**
 * Whether a number could be a process id at all.
 *
 * Its own function, and exported, because the rule is not observable through `identify` on every
 * platform: Linux answers from `/proc`, where an out-of-range id is simply a path that does not
 * exist, so a test going through `identify` asserts nothing there and the gate mutation for this
 * survived on Linux CI while passing on macOS. That is the same platform-dependence review caught
 * in the locale test. The rule lives here so it can be checked without an operating system.
 */
export function isPossiblePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid < PID_CEILING;
}

/**
 * Reads a process's start time from `/proc`, the way Linux exposes it.
 *
 * Field 22 of `/proc/<pid>/stat` is the start time in clock ticks since boot. Converting it to
 * wall-clock needs the boot time, which is why `/proc/stat`'s `btime` is read too — and the
 * conversion is deliberately not cached across calls, because a lock check happens once per run
 * and a stale cached boot time would be a bug that only appears after a suspend.
 *
 * Parsed from the last `)` rather than by splitting on spaces from the start: field 2 is the
 * executable name in parentheses and may itself contain spaces and parentheses, which is the
 * classic way of misreading this file.
 */
async function procIdentify(pid: number): Promise<ProbeAnswer> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    // ENOENT is the answer; anything else — EACCES under a hardened `hidepid`, EIO — is a
    // question that could not be asked, and must not read as a dead process.
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ESRCH") return { kind: "not-found" };
    return {
      kind: "unknown",
      reason: `/proc/${pid}/stat could not be read (${code ?? error})`,
    };
  }

  const afterName = stat.slice(stat.lastIndexOf(")") + 1).trim();
  // Fields 3 onwards. Field 22 overall is therefore index 19 here.
  const ticks = Number(afterName.split(/\s+/)[19]);
  if (!Number.isFinite(ticks)) {
    return {
      kind: "unknown",
      reason: `/proc/${pid}/stat did not parse as process stats`,
    };
  }

  let bootSeconds: number;
  try {
    const bootMatch = /^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"));
    bootSeconds = Number(bootMatch?.[1]);
  } catch (error) {
    return { kind: "unknown", reason: `/proc/stat could not be read (${String(error)})` };
  }
  if (!Number.isFinite(bootSeconds)) {
    return { kind: "unknown", reason: "/proc/stat carries no btime" };
  }

  // USER_HZ, fixed at 100 on Linux for the purposes of this file regardless of the kernel's
  // internal tick rate. There is no syscall-free way to read it, and it has not been anything
  // else on a Linux target awcli supports.
  const startedAt = Math.round(bootSeconds * 1000 + (ticks / 100) * 1000);
  return { kind: "running", identity: { pid, startedAt } };
}

/**
 * The PATH a `ps` child is given: the operator's, minus every entry that resolves out of the working
 * directory.
 *
 * `execvp` is what resolves the bare name `ps`, and it searches PATH *relative to the process's
 * working directory*: an empty entry and a relative one both mean "here". Reproduced on this machine
 * with a `ps` of mine in the working directory — `PATH=""`, `PATH=":/usr/bin:/bin"` and `PATH="."`
 * each ran my script instead of `ps`, and `PATH=".."` ran the one a directory up, on the host and
 * under the operator's identity. `PATH="/nonexistent:"`, `PATH="/nonexistent::/bin"` and
 * `PATH="/nonexistent:/alsonot:"` ran it too, which is the same reproduction for the trailing and
 * doubled colon: they are that entry, and they decide it whenever nothing earlier on the path holds
 * a `ps`.
 *
 * What that costs here is worse than an unanswered question, because a plant that exits 0 saying
 * nothing is read as an *answer*: empty stdout is `not-found` below, `not-found` is `gone` in
 * `livenessOf`, and `gone` evicts a live run's lock. So it reaches the one fail-open this whole file
 * is arranged around, by deciding which binary answers rather than by misreading one that did.
 *
 * Weaker than the same hole in awcli's git subprocess, and repaired anyway. That one runs with its
 * working directory set to an agent's own worktree, so the directory an entry resolves against is
 * one an agent writes to; this call passes no `cwd` at all and inherits awcli's own, which is the
 * operator's. The resolver, the mechanism and the repair are identical, and the precondition — a
 * PATH carrying an empty or relative entry — is one nobody configures on purpose, which is exactly
 * what makes it a thing awcli should not depend on being false.
 *
 * Sanitising the entries rather than resolving `ps` to an absolute path once. `psIdentify` is
 * exported and called directly by its own tests, and `runPsBounded` is called with binaries standing
 * in for `ps`, so a name resolved at module load would either not be the name that ran or would need
 * a second code path beside it. Editing the environment leaves the resolution exactly where it was
 * and takes away only the entries that could move it.
 *
 * When nothing absolute survives the variable is *removed* rather than emptied, and the difference
 * is the whole point: measured here, `PATH=""` is a PATH of one empty entry and that entry is the
 * working directory, so emptying it hands the attack back. Absent, `execvp` falls back to the
 * platform's own confstr default — absolute throughout, and it found the real `ps` on this Darwin.
 * A `ps` reachable only through a dropped entry therefore comes back as a `ps` that could not be
 * run, which is the right answer rather than a regression: a PATH whose `ps` depends on which
 * directory the process happens to be in names a different binary from one call to the next, and
 * `self()` says so with a remedy any absolute directory satisfies.
 *
 * A leading `/` rather than `isAbsolute`, and `":"` rather than `delimiter`: the question is what
 * `execvp` does with a PATH entry, which is a POSIX question, and everything below this is a POSIX
 * assumption too — the adapter's whole mechanism is a `ps` that takes `-o lstart=`, and Windows has
 * no such program to find. A port would have to revisit both together, and one of them silently
 * agreeing with Windows while the other does not is worse than neither.
 *
 * Exported so the rule can be checked entry by entry without an operating system, for the reason
 * `isPossiblePid` is: the end-to-end proof needs a `ps` on the machine *and* a working directory a
 * test may plant one in, and a rule observable only that way is a rule CI can quietly stop checking.
 */
export function psSearchPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const absolute = value.split(":").filter((entry) => entry.startsWith("/"));
  return absolute.length === 0 ? undefined : absolute.join(":");
}

/**
 * The environment a `ps` child is given: this process's, with the locale pinned and PATH narrowed.
 *
 * Two edits, together because they are the same claim about two halves of one contract. `LC_ALL=C`
 * is why `-o lstart=` prints something `Date.parse` can read — see `psIdentify`. `PATH` is why the
 * thing printing it is `ps` — see `psSearchPath`.
 *
 * Everything else is passed through rather than allowlisted. `ps` reads little of the environment
 * and a list of what to keep would go stale silently; the two variables that decide what awcli gets
 * back are the two that are named.
 */
function psEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  // Removed outright when no absolute entry survives, because the empty string is a PATH of one
  // empty entry and that entry is the working directory — see `psSearchPath`.
  const searchPath = psSearchPath(environment.PATH);
  if (searchPath === undefined) delete environment.PATH;
  else environment.PATH = searchPath;
  return environment;
}

/**
 * awcli's own bound expiring, shaped like the error `execFile` raises when its own bound expires.
 *
 * So that there is one timeout arm and one timeout sentence. `psIdentify` decides a timeout by
 * reading `killed`, and this is what carries that answer up from the settlements where `execFile`
 * reports no kill at all. A second sentence saying the same thing in different words would be a
 * second thing for an operator to reconcile, out of the one file whose job is telling "could not
 * ask" from "nothing is there".
 *
 * The message is a marker rather than prose for anybody: what an operator reads is the reason
 * `psIdentify` writes in the arm this reaches.
 */
class PsBoundExpired extends Error {
  readonly killed = true;

  constructor(cause: unknown) {
    super("awcli's bound on this ps invocation expired", { cause });
  }
}

/**
 * One `ps` invocation, bounded by a clock of awcli's own rather than by `execFile`'s.
 *
 * Why the promisified form could not answer the question this exists to ask. `promisify(execFile)`
 * resolves with `{ stdout, stderr }` and discards the `ChildProcess`, so on the *resolve* path there
 * is no `killed` and no `signal` to read — and the resolve path is reachable after a kill. Measured
 * on node 22.21.1 with a child that leaves a descendant holding stdout and exits, under
 * `timeout: 2000`: the promise **resolved successfully** at 2015ms with `stdout: ""`, the
 * descendant's later line lost. node's own timeout destroys the pipes, the already-exited child then
 * reports code 0 and signal null, and execFile's internal `killed` flag is never consulted once the
 * code is 0.
 *
 * The empty stdout is what makes that the worst available kind of wrong. `psIdentify` reads it as
 * `not-found`, `livenessOf` reads that as `gone`, and `gone` evicts a live run's lock — so the bound
 * written so that a slow machine costs a refusal and never a reclamation was, on exactly the loaded
 * machine it was written for, producing a reclamation. `ps` itself spawns nothing and is a less
 * likely child than git to leave a pipe held; a wrapper script around it is not, and hardened and
 * audited images ship those. The cost of the unlikely case is the one outcome this file is arranged
 * to make impossible, so it is closed rather than recorded.
 *
 * Nor can the `ChildProcess` answer it, which is why the flag below is awcli's own rather than the
 * child's. Measured on the same case: at the bound, `child.kill("SIGTERM")` returned false and
 * `child.killed` stayed false, the signal having landed on a process that had already exited.
 * Nothing the operating system says distinguishes "awcli gave up on this" from "this finished";
 * only awcli knows, so only awcli can record it.
 *
 * Hence: no `timeout` option, a timer of awcli's own, that flag read before either settlement is
 * trusted, and the cleanup after it on a bound of its own (`PS_CLEANUP_TIMEOUT_MS`).
 *
 * Exported, with the binary and the bound as parameters, for the tests that cannot be written any
 * other way — the same seam `psIdentify` and `isPossiblePid` are exported through. Proving that a
 * bound awcli enforced is a fault needs a child that will not answer inside it and a bound short
 * enough that a suite can wait it out; `sh` stands in for `ps` there because what is under test is
 * this function and not `ps`. Neither parameter is a configuration point: awcli calls this in one
 * place, with `ps` and the default.
 */
export function runPsBounded(
  binary: string,
  args: readonly string[],
  timeoutMs: number = PS_TIMEOUT_MS,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    // Whether awcli's bound is what ended this call. See above: neither settlement of `execFile` nor
    // the `ChildProcess` carries that answer, so it is kept here.
    let expired = false;
    let settled = false;
    let bound: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;

    // Both timers and the callback can be first, and the two that are not must do nothing at all:
    // destroying the pipes to give up on a child makes `execFile` call back immediately, so the
    // losing path is not hypothetical.
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(bound);
      clearTimeout(grace);
      settle();
    };

    const child = execFile(
      binary,
      [...args],
      { encoding: "utf8", env: psEnvironment() },
      (error, stdout, stderr) => {
        finish(() => {
          // The flag before the settlement, which is the whole of it: this callback arrives with
          // `error === null` and an empty `stdout` for a child awcli killed, whenever the child had
          // exited and something it left behind was holding the pipes.
          if (expired) reject(new PsBoundExpired(error));
          // What the child printed, put on the error, because a non-zero exit is an *answer* here:
          // `psIdentify` tells "nothing holds that id" from "this `ps` will not take the question"
          // by reading the status and the stderr together, and node's callback hands them beside the
          // error rather than on it. This is the one thing `promisify(execFile)` was doing that had
          // to be kept.
          else if (error !== null) reject(Object.assign(error, { stdout, stderr }));
          else resolve({ stdout, stderr });
        });
      },
    );

    bound = setTimeout(() => {
      expired = true;
      child.kill("SIGTERM");
      grace = setTimeout(() => {
        finish(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.kill("SIGKILL");
          reject(new PsBoundExpired(undefined));
        });
      }, PS_CLEANUP_TIMEOUT_MS);
    }, timeoutMs);
  });
}

/**
 * Reads a process's start time from `ps`, the way macOS exposes it.
 *
 * `LC_ALL=C` is not tidiness. `-o lstart=` prints a *localised* absolute time, and `Date.parse`
 * understands only the C one: under `fr_FR.UTF-8` the same process reports
 * `mer. 26 août 19:52:19 2026`, which parses as NaN — so on a French-locale machine every
 * `self()` threw and no run could ever take a lock. `de_DE` parsed only by luck of its
 * abbreviations. Pinning the locale is what makes the format a contract instead of a coincidence.
 *
 * The pin itself lives in `psEnvironment`, alongside the narrowing of `PATH` that decides which
 * `ps` prints the line in the first place. Both are stated there rather than here.
 *
 * Exported for the test that checks the pin, which has to call this on Linux too — where
 * `identify` goes to `/proc` and never reaches here, so a suite that went through `identify`
 * asserted nothing at all on the platform most of CI runs on.
 *
 * `timeoutMs` is a defaulted parameter for a neighbouring reason. Proving that a bound awcli had
 * to enforce comes back as "could not ask" rather than as "nothing holds that id" means waiting the
 * bound out, and a suite that waits `PS_TIMEOUT_MS` for each such case is a suite nobody keeps. It
 * is not a configuration point — `identify` calls this with the default — and the sentence below
 * names the bound that was passed rather than the constant, so one wording covers whichever bound
 * expired.
 */
export async function psIdentify(
  pid: number,
  timeoutMs: number = PS_TIMEOUT_MS,
): Promise<ProbeAnswer> {
  let stdout: string;
  try {
    ({ stdout } = await runPsBounded(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      timeoutMs,
    ));
  } catch (error) {
    const failure = error as {
      code?: string | number;
      killed?: boolean;
      signal?: string;
      stderr?: string;
    };
    // `ps -p` on an id nothing holds exits 1 with no output. That is the answer — but only when it
    // said nothing on the way out. Review flagged trusting the status alone: a `ps` that does not
    // take `-o lstart=` at all, busybox's being the one that ships in container images, also exits
    // 1, and reading that as "no such process" evicts a *live* owner's lock on every ask. An
    // unrecognised option is a question that could not be put, and it is distinguishable because
    // it is the one that complains first.
    const complaint = (failure.stderr ?? "").trim();
    if (failure.code === 1 && failure.killed !== true && complaint.length === 0) {
      return { kind: "not-found" };
    }
    // Everything else is a question that could not be asked: `ps` absent from the image or
    // reachable only through a PATH entry `psSearchPath` drops (ENOENT), the bound in
    // `runPsBounded` expiring (killed, however `execFile` itself settled), EAGAIN from fork on a
    // loaded box.
    // `complaint` is another program's stderr, and the reason reaches a terminal two ways: through
    // a refusal, and through the startup throw in `self()`. Sanitised here rather than at each
    // consumer, so a `ps` that prints an escape sequence cannot repaint a screen through whichever
    // consumer is added next.
    return {
      kind: "unknown",
      reason:
        failure.killed === true
          ? `ps did not answer within ${timeoutMs}ms`
          : complaint.length > 0
            ? `ps refused the question (${printable(complaint.split("\n")[0] ?? "", COMPLAINT_LIMIT)})`
            : `ps could not be run (${printable(String(failure.code ?? error))})`,
    };
  }

  const printed = stdout.trim();
  if (printed.length === 0) return { kind: "not-found" };
  const startedAt = Date.parse(printed);
  if (!Number.isFinite(startedAt)) {
    return {
      kind: "unknown",
      reason: `ps reported an unparseable start time (${printed})`,
    };
  }
  return { kind: "running", identity: { pid, startedAt } };
}

/**
 * This process's identity, resolved once.
 *
 * Memoised because it cannot change — a process's own start time is fixed — and because the
 * uncached version spawned `ps` several times per acquisition, each one a blocked event loop.
 */
let ownIdentity: Promise<ProcessIdentity> | undefined;

/**
 * The real probe: asks the operating system, and answers for this process the same way.
 *
 * `self()` goes through `identify(process.pid)` rather than through anything derived from
 * `process.uptime()`, and that is not a shortcut — it is the property the whole comparison rests
 * on. The value written into a lock and the value a later run reads back for the same process must
 * come from the same source, or a live owner's identity will fail to match its own recorded one
 * and every lock will read as stale. Deriving `self` differently is how that bug gets written;
 * there is only one source here, so it cannot be.
 */
export const systemProcessProbe: ProcessProbe = {
  self(): Promise<ProcessIdentity> {
    // Named rather than `this.identify`: a caller that destructures the probe would otherwise
    // lose `this`, and the failure would surface as a thrown error on the startup path.
    ownIdentity ??= systemProcessProbe.identify(process.pid).then((answer) => {
      if (answer.kind === "running") return answer.identity;
      // Reachable, and the comment here long claimed otherwise — "a process asking about itself is
      // running by definition", which is true of `not-found` and says nothing at all about the
      // branch that actually fires. `unknown` reaches this: a container image whose `ps`
      // does not take `-o lstart=` answers it on every ask, so does a `/proc` a hardened `hidepid`
      // will not show us, and so does a PATH whose only `ps` sits behind an entry `psSearchPath`
      // drops — which is why the remedy below names an absolute directory as well as a package.
      // Failing loudly rather than inventing a start time, because a
      // wrong `startedAt` here would be written into the lock and would make this run's own lock
      // look stale to the next one — so awcli would refuse its own name for reasons nobody could
      // trace. The message carries the probe's reason for exactly that.
      throw new Error(
        `awcli cannot determine its own start time (pid ${process.pid}): ${
          answer.kind === "unknown"
            ? answer.reason
            : "the process table has no entry for it"
        }. It needs that to hold a run lock a later run can tell apart from a recycled process id. ` +
          `Install ps (the procps package on most images), put the directory holding it on PATH as an absolute path, or run awcli on a host that will report process start times.`,
      );
    });
    // Not cached on failure: a transient `ps` timeout should not poison every later attempt in
    // this process, and the throw above is what a retry has to be able to get past.
    const pending = ownIdentity;
    return pending.catch((error: unknown) => {
      if (ownIdentity === pending) ownIdentity = undefined;
      throw error;
    });
  },

  async identify(pid: number): Promise<ProbeAnswer> {
    // Out of range before it is asked about. A number no operating system can assign as a process
    // id is not a process, and asking anyway makes `ps` complain — which, now that a complaint on
    // stderr is read as "the question could not be put", would come back as `undecidable` and turn
    // a lock holding junk into a refusal no operator could clear.
    if (!isPossiblePid(pid)) {
      return { kind: "not-found" };
    }
    return process.platform === "linux" ? procIdentify(pid) : psIdentify(pid);
  },
};

/** Test seam: forget the memoised identity so a suite can exercise `self()` from cold. */
export function forgetOwnIdentity(): void {
  ownIdentity = undefined;
}
