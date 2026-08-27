import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  forgetOwnIdentity,
  livenessOf,
  psIdentify,
  systemProcessProbe,
  type ProcessIdentity,
} from "../../src/runtime/process-probe.js";

const execFileAsync = promisify(execFile);

/** A locale whose `lstart` `Date.parse` cannot read, where the C library has it. */
const FRENCH = "fr_FR.UTF-8";

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
    expect(await livenessOf(self, systemProcessProbe)).toBe("live");
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
      expect(await livenessOf(answer.identity, systemProcessProbe)).toBe("live");

      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;

      // A killed run's lock must read as reclaimable, which is exactly this answer.
      expect(await livenessOf(answer.identity, systemProcessProbe)).toBe("gone");
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
    expect(await livenessOf(owner, probe)).toBe("undecidable");

    const absent = {
      self: () => Promise.resolve({ pid: 1, startedAt: 1 }),
      identify: () => Promise.resolve({ kind: "not-found" } as const),
    };
    expect(await livenessOf(owner, absent)).toBe("gone");
  });
});
