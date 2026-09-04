import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  forgetOwnIdentity,
  isPossiblePid,
  livenessOf,
  psIdentify,
  psSearchPath,
  runPsBounded,
  systemProcessProbe,
  type ProcessIdentity,
} from "../../src/runtime/process-probe.js";

const execFileAsync = promisify(execFile);

/** A locale whose `lstart` `Date.parse` cannot read, where the C library has it. */
const FRENCH = "fr_FR.UTF-8";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "awcli-probe-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * A child that prints part of its answer, hands stdout to something that outlives it, and exits.
 *
 * `sh` stands in for `ps` here because the runner is what is under test — the same reason
 * `runPsBounded` takes the binary at all. The subshell inherits the pipe and is not awcli's child,
 * so nothing awcli can signal will close it, which is the point. `printf` after the sleep so the
 * late write is there to be lost, and `exit 0` so the child is genuinely gone by the time the bound
 * expires: that is what makes `execFile` report success for a call awcli killed.
 */
function holdingStdoutPast(seconds: number): string {
  return `printf 'PARTIAL\\n'; (sleep ${seconds}; printf 'LATE\\n') & exit 0`;
}

/** Whether a path is there at all — used to ask whether a planted binary ever ran. */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** The marker a planted `ps` writes beside itself, so "did it run" is a fact and not an inference. */
const PLANT_MARKER = "PLANTED-PS-RAN";

/**
 * A `ps` of the attacker's, in `where`, that exits 0 having printed nothing.
 *
 * Silence and a zero status on purpose, because that is the damaging plant rather than a noisy one:
 * empty stdout is `not-found`, `not-found` is `gone`, and `gone` evicts a live run's lock. A plant
 * that complained would come back as `unknown` and cost only a refusal.
 */
/**
 * An absolute directory on this machine's own PATH that holds an executable `ps`, if there is one.
 *
 * Read from the machine rather than written down, because `ps` is `/bin/ps` on this Darwin and
 * `/usr/bin/ps` on most Linux images, and a test that hard-codes either asserts the wrong thing on
 * the other. It is only used to build the *attack* PATHs below — a real entry for the degenerate one
 * to sit in front of — so using the environment here is not using the rule under test. Taken as an
 * argument rather than read from `process.env`, because the test that wants it has by then removed
 * `PATH` to establish its own precondition, and reading it there answered "this machine has no ps"
 * and skipped the whole test with a tick.
 */
async function psDirectory(path: string | undefined): Promise<string | undefined> {
  for (const entry of (path ?? "").split(":")) {
    if (!entry.startsWith("/")) continue;
    if (await exists(join(entry, "ps"))) return entry;
  }
  return undefined;
}

async function plantPs(where: string): Promise<void> {
  const script = join(where, "ps");
  await writeFile(
    script,
    `#!/bin/sh\nprintf 'ran\\n' > "$(dirname "$0")/${PLANT_MARKER}"\nexit 0\n`,
    { mode: 0o755 },
  );
}

/**
 * What `ps` prints for this process under a locale, with nothing pinned.
 *
 * Empty when `ps` will not answer at all. This exists so the locale test can establish that the
 * locale it is using actually changes the output on *this* machine before asserting anything about
 * the pin: a locale the C library has not been given falls back to C, and then the assertion holds
 * whether the adapter pins anything or not.
 */
async function lstartUnder(locale: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-o", "lstart=", "-p", String(process.pid)],
      { encoding: "utf8", env: { ...process.env, LC_ALL: locale, LC_TIME: locale } },
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * The lock's own tests drive every decision through a substitute probe, so this suite is what
 * keeps the substitute honest. If the adapter reports a live process as gone, every lock in the
 * world reads as stale and no amount of fake-driven testing above would show it.
 */
describe("asking the operating system who is running", () => {
  it("reports this process as alive, and the same start time each time it is asked", async () => {
    const self = await systemProcessProbe.self();
    expect(self.pid).toBe(process.pid);
    expect(await systemProcessProbe.identify(process.pid)).toEqual({
      kind: "running",
      identity: self,
    });
    expect((await livenessOf(self, systemProcessProbe)).liveness).toBe("live");
  });

  it("reports a start time consistent with how long this process has been up", async () => {
    forgetOwnIdentity();
    const self = await systemProcessProbe.self();
    const uptimeMs = process.uptime() * 1000;
    // Three seconds of slack: the OS reports the start to the second on macOS, Linux derives it
    // from a boot time that is also only to the second, and the two readings are not simultaneous.
    // Still tight enough to catch the failures that matter — a boot-relative value, a
    // seconds-versus-milliseconds mix-up, or an invented start time.
    expect(Date.now() - self.startedAt).toBeGreaterThan(uptimeMs - 3_000);
    expect(Date.now() - self.startedAt).toBeLessThan(uptimeMs + 3_000);
  });

  /**
   * `-o lstart=` prints a *localised* time, and `Date.parse` understands only the C one. Under
   * fr_FR the same process reports `mer. 26 août ...`, which parses as NaN — so every `self()`
   * threw and no run could take a lock at all. The adapter pins LC_ALL; this asks under a locale
   * that would otherwise break it.
   *
   * Two things review was right about in the first version of this test. It went through
   * `identify`, which on Linux reads `/proc` and never reaches `ps` at all — so on the platform
   * most of CI runs on it asserted nothing, and the mutation that removes the pin would not have
   * turned it red. And it passed on a machine whose C library has never been given fr_FR, because
   * `ps` then falls back to C and prints something parseable regardless. So: `psIdentify` directly,
   * and the localisation is *established* first, with an explicit skip when it cannot be. A test
   * that cannot fail must say so rather than print a tick.
   */
  it("answers under a locale whose date format Date.parse cannot read", async (ctx) => {
    const localised = await lstartUnder(FRENCH);
    if (localised.length === 0 || Number.isFinite(Date.parse(localised))) {
      ctx.skip(
        `this machine's ps does not localise lstart under ${FRENCH} (it printed "${localised}"), so the pin cannot be observed here`,
      );
      return;
    }

    const previous = { all: process.env["LC_ALL"], time: process.env["LC_TIME"] };
    process.env["LC_ALL"] = FRENCH;
    process.env["LC_TIME"] = FRENCH;
    try {
      const answer = await psIdentify(process.pid);
      expect(answer.kind).toBe("running");
      if (answer.kind !== "running") return;
      expect(Number.isFinite(answer.identity.startedAt)).toBe(true);
      expect(answer.identity.startedAt).toBeLessThanOrEqual(Date.now());
    } finally {
      if (previous.all === undefined) delete process.env["LC_ALL"];
      else process.env["LC_ALL"] = previous.all;
      if (previous.time === undefined) delete process.env["LC_TIME"];
      else process.env["LC_TIME"] = previous.time;
      forgetOwnIdentity();
    }
  });

  it("reports a real child process as alive, and as gone once it exits", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      stdio: "ignore",
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const pid = child.pid;
      expect(pid).toBeDefined();
      if (pid === undefined) return;

      const answer = await systemProcessProbe.identify(pid);
      expect(answer.kind).toBe("running");
      if (answer.kind !== "running") return;
      expect((await livenessOf(answer.identity, systemProcessProbe)).liveness).toBe(
        "live",
      );

      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;

      // A killed run's lock must read as reclaimable, which is exactly this answer.
      expect((await livenessOf(answer.identity, systemProcessProbe)).liveness).toBe(
        "gone",
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("answers not-found for an id no process can hold", async () => {
    expect(await systemProcessProbe.identify(0)).toEqual({ kind: "not-found" });
    expect(await systemProcessProbe.identify(-1)).toEqual({ kind: "not-found" });
    expect((await systemProcessProbe.identify(2 ** 31)).kind).toBe("not-found");
  });

  /**
   * The distinction the first version of this file did not make. A probe that cannot ask must not
   * answer "gone", because "gone" evicts a live owner's lock — and it would do so on a loaded
   * machine, which is exactly when a second run is present to collide with.
   */
  it("keeps 'could not ask' apart from 'nothing holds that id'", async () => {
    const unknown = { kind: "unknown", reason: "the probe could not run" } as const;
    const probe = {
      self: () => Promise.resolve({ pid: 1, startedAt: 1 }),
      identify: () => Promise.resolve(unknown),
    };
    const owner: ProcessIdentity = { pid: 4242, startedAt: 1_700_000_000_000 };
    expect(await livenessOf(owner, probe)).toEqual({
      liveness: "undecidable",
      // Carried, not dropped. A refusal that cannot say *why* the question went unanswered is one
      // nobody can act on: `ps` missing from a container image never clears, and a `ps` that timed
      // out on a busy machine clears on its own, and the two produce the same refusal without this.
      reason: "the probe could not run",
    });

    const absent = {
      self: () => Promise.resolve({ pid: 1, startedAt: 1 }),
      identify: () => Promise.resolve({ kind: "not-found" } as const),
    };
    expect(await livenessOf(owner, absent)).toEqual({
      liveness: "gone",
      reason: undefined,
    });
  });

  /**
   * The bound expiring on a real child that then reports success, which is the case the mocked
   * suite stages and this one proves against the operating system.
   *
   * A child prints part of its answer, hands stdout to a subshell that outlives it, and exits. The
   * pipe stays open, so `execFile` has nothing to report; awcli's bound expires with the child
   * already gone; and when the subshell finally lets go the settlement is a *success*. Measured on
   * node 22.21.1: `promisify(execFile)` with `timeout: 2000` resolved at 2015ms with `stdout: ""` for
   * the `ps`-shaped version of this, the late write lost. Nothing in that settlement says awcli gave
   * up — and the `ChildProcess` does not say so either: at the bound, `child.kill("SIGTERM")`
   * returned false and `child.killed` stayed false, the signal having landed on a process that had
   * already exited. So the flag has to be awcli's own, and this is the test that reads it.
   *
   * Asserted on `killed`, because that is the field `psIdentify` classifies from: it is what turns
   * this into "could not ask" rather than the `not-found` that a truncated answer produces.
   */
  it("reports a call its own bound ended as a fault, however execFile settled", async () => {
    const thrown = await runPsBounded("sh", ["-c", holdingStdoutPast(0.25)], 50).then(
      (answer) => answer,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { readonly killed?: boolean }).killed).toBe(true);
  });

  /**
   * The same shape with a subshell that does not let go inside any bound awcli would pick.
   *
   * node's own `timeout` option was what destroyed the pipes; awcli taking the clock over means
   * awcli has to, or waiting for that pipe turns a bounded question into an unbounded wait on the
   * startup path — the failure `PS_TIMEOUT_MS` exists to prevent, reintroduced one level up. Hence
   * the second bound: SIGTERM, `PS_CLEANUP_TIMEOUT_MS` of grace, then the pipes are destroyed,
   * SIGKILL is sent and the fault is raised whether or not anything ever answered.
   *
   * The elapsed time is asserted as well as the outcome, because the outcome alone cannot tell a
   * bounded wait from one that merely finished — the subshell here does eventually let go, and a
   * `killed` fault is what comes back either way.
   *
   * The three seconds it holds for, and the 1500ms it is held to, are chosen against the wrong
   * implementations rather than for comfort. Correct, this settles at the bound plus the grace:
   * 50ms + 1000ms. Handed the *call's* bound instead of its own — which is the plausible mistake,
   * deriving the grace from the timeout — it settles at 50ms + 2000ms, and the hold is longer than
   * that so the grace and not the child is what decides. 1500ms sits between the two with ~450ms
   * either side.
   */
  it("gives up on a held pipe within a bound separate from the call's", async () => {
    const started = Date.now();
    const thrown = await runPsBounded("sh", ["-c", holdingStdoutPast(3)], 50).then(
      (answer) => answer,
      (error: unknown) => error,
    );
    const elapsed = Date.now() - started;

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { readonly killed?: boolean }).killed).toBe(true);
    expect(elapsed).toBeLessThan(1_500);
  });

  /**
   * A `ps` planted in the working directory, across every spelling of "here" a PATH can carry.
   *
   * `execvp` resolves the bare name `ps` relative to the process's working directory, so an empty
   * entry and a relative one are both a way for that directory to decide which binary answers.
   * Reproduced on this machine before the repair: with a `ps` of mine in the working directory,
   * `PATH=""`, `PATH=":/usr/bin:/bin"` and `PATH="."` each ran my script, and `PATH=".."` ran the one
   * a directory up — on the host, under the operator's identity.
   *
   * What it costs is the fail-open this whole file is arranged around, reached by deciding which
   * binary answers rather than by misreading one that did: the plant exits 0 having printed nothing,
   * empty stdout is `not-found`, `not-found` is `gone`, and `gone` evicts a live run's lock. So both
   * halves are asserted — that the answer is still this live process, and that neither plant ever
   * ran. The marker is what makes the second half a fact rather than an inference.
   *
   * The precondition is established first, with `PATH` absent: that is what every spelling below
   * degrades to once the relative entries are dropped, and a machine where it does not find `ps` is
   * a machine where this test cannot observe anything. `psIdentify` directly rather than through
   * `identify`, because on Linux `identify` reads `/proc` and never reaches `ps` at all.
   */
  it("does not let the working directory decide which ps answers", async (ctx) => {
    const outer = await directory();
    const inner = join(outer, "inner");
    await mkdir(inner);
    await plantPs(outer);
    await plantPs(inner);

    const wasIn = process.cwd();
    const hadPath = process.env["PATH"];
    try {
      process.chdir(inner);
      // The real entry is this machine's own, so that the case staged below is "the plant wins the
      // search" rather than "nothing on this PATH holds a ps at all".
      const real = await psDirectory(hadPath);
      if (real === undefined) {
        ctx.skip(
          "no absolute entry on this machine's PATH holds a ps, so a plant cannot be put in front of the real one",
        );
        return;
      }

      delete process.env["PATH"];
      const baseline = await psIdentify(process.pid);
      if (baseline.kind !== "running") {
        ctx.skip(
          `no ps on this machine's default search path (it answered ${baseline.kind}), so a planted one cannot be told from the real one here`,
        );
        return;
      }

      // Every way a PATH entry can mean "the directory this process happens to be in": the empty
      // string, which is a PATH of one such entry; a leading colon, which is that entry in front of
      // a real one; `.` and `..`, alone and in front of a real one; and a bare relative name.
      for (const spelling of [
        "",
        ".",
        "..",
        "tools",
        `:${real}`,
        `.:${real}`,
        `..:${real}`,
      ]) {
        process.env["PATH"] = spelling;
        const answer = await psIdentify(process.pid);
        expect(answer, `PATH=${JSON.stringify(spelling)}`).toMatchObject({
          kind: "running",
          identity: { pid: process.pid },
        });
      }

      expect(await exists(join(inner, PLANT_MARKER))).toBe(false);
      expect(await exists(join(outer, PLANT_MARKER))).toBe(false);
    } finally {
      process.chdir(wasIn);
      if (hadPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = hadPath;
      forgetOwnIdentity();
    }
  });
});

/**
 * The PATH rule, checked entry by entry without an operating system.
 *
 * For the reason the range check above is: the end-to-end proof needs a `ps` on the machine *and* a
 * working directory a test may plant one in, and it skips itself where the first is missing — so a
 * rule observable only that way is a rule CI can quietly stop checking. It is also the half that
 * pins the *shape* of the repair rather than only its effect: narrowing PATH to the empty string
 * would satisfy "no relative entry survives" and hand the attack straight back, because the empty
 * string is a PATH of one entry and that entry is the working directory.
 */
describe("which PATH entries may resolve a ps", () => {
  it.each([
    {
      label: "keeps the absolute entries in order",
      given: "/usr/bin:/bin",
      want: "/usr/bin:/bin",
    },
    {
      label: "drops a leading empty entry",
      given: ":/usr/bin:/bin",
      want: "/usr/bin:/bin",
    },
    {
      label: "drops a trailing empty entry",
      given: "/usr/bin:/bin:",
      want: "/usr/bin:/bin",
    },
    {
      label: "drops a doubled colon's empty entry",
      given: "/usr/bin::/bin",
      want: "/usr/bin:/bin",
    },
    { label: "drops the working directory", given: ".:/usr/bin", want: "/usr/bin" },
    { label: "drops its parent", given: "..:/usr/bin", want: "/usr/bin" },
    { label: "drops a bare relative name", given: "tools:/usr/bin", want: "/usr/bin" },
    {
      label: "drops a relative path with a separator in it",
      given: "a/b:/usr/bin",
      want: "/usr/bin",
    },
    // Removed, not emptied. Every one of these is a PATH whose only entries mean "here".
    {
      label: "removes an empty PATH rather than passing it on",
      given: "",
      want: undefined,
    },
    { label: "removes a PATH of nothing but colons", given: "::", want: undefined },
    {
      label: "removes a PATH of nothing but relative entries",
      given: ".:..:tools",
      want: undefined,
    },
    // An absent PATH is left absent: `execvp` then uses the platform's own absolute default, which
    // is the fallback the removal above is relying on.
    { label: "leaves an absent PATH absent", given: undefined, want: undefined },
  ])("$label", ({ given, want }) => {
    expect(psSearchPath(given)).toBe(want);
  });
});

/**
 * The range check, tested without an operating system.
 *
 * On Linux `identify` answers out-of-range ids from `/proc`, where they are simply paths that do not
 * exist — so going through `identify` proves nothing there, and the first version of this gate
 * survived on Linux CI while passing on macOS. The numbers are written out rather than imported
 * from the module: a test that reads the constant it is checking cannot catch a wrong constant.
 */
describe("what could be a process id at all", () => {
  it.each([
    { label: "the first id", pid: 1, possible: true },
    { label: "an ordinary id", pid: 4242, possible: true },
    // PID_MAX_LIMIT is 2^22 and bounds pid_max, which is itself exclusive — so the largest id an
    // OS will issue is one below it, and the comparison is strict. The check used to accept 2^22
    // itself, which is harmless in effect (one more impossible id asked about) but made the comment
    // justifying the constant untrue, and that comment is the whole reason the limit is not read
    // from /proc at run time.
    { label: "the largest id Linux will issue", pid: 4_194_303, possible: true },
    {
      label: "PID_MAX_LIMIT itself, which is never issued",
      pid: 4_194_304,
      possible: false,
    },
    { label: "one past that", pid: 4_194_305, possible: false },
    { label: "an id that would make ps complain", pid: 2_147_483_648, possible: false },
    { label: "zero", pid: 0, possible: false },
    { label: "a negative id", pid: -1, possible: false },
    { label: "a fraction", pid: 1.5, possible: false },
    { label: "not a number", pid: Number.NaN, possible: false },
  ])("says $label is $possible", ({ pid, possible }) => {
    expect(isPossiblePid(pid)).toBe(possible);
  });

  it("answers an impossible id without asking the operating system", async () => {
    // Whatever the platform, the answer is that nothing holds it — never "could not decide", which
    // is what asking `ps` about it produces and what an operator cannot clear.
    expect(await systemProcessProbe.identify(2_147_483_648)).toEqual({
      kind: "not-found",
    });
  });
});
