import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  forgetOwnIdentity,
  livenessOf,
  systemProcessProbe,
  type ProcessIdentity,
} from "../../src/runtime/process-probe.js";

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
   * `-o lstart=` prints a *localised* time on macOS, and `Date.parse` understands only the C one.
   * Under fr_FR the same process reports `mer. 26 août ...`, which parses as NaN — so every
   * `self()` threw and no run could take a lock at all. The adapter pins LC_ALL; this asserts the
   * pinning works by asking under a locale that would otherwise break it.
   */
  it("answers under a locale whose date format Date.parse cannot read", async () => {
    const previous = process.env["LC_ALL"];
    const previousTime = process.env["LC_TIME"];
    process.env["LC_ALL"] = "fr_FR.UTF-8";
    process.env["LC_TIME"] = "fr_FR.UTF-8";
    try {
      forgetOwnIdentity();
      const answer = await systemProcessProbe.identify(process.pid);
      expect(answer.kind).toBe("running");
      if (answer.kind !== "running") return;
      expect(Number.isFinite(answer.identity.startedAt)).toBe(true);
      expect(answer.identity.startedAt).toBeLessThanOrEqual(Date.now());
    } finally {
      if (previous === undefined) delete process.env["LC_ALL"];
      else process.env["LC_ALL"] = previous;
      if (previousTime === undefined) delete process.env["LC_TIME"];
      else process.env["LC_TIME"] = previousTime;
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
