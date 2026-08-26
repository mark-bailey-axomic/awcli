import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DisposalStack, withDisposal } from "../../src/runtime/disposal.js";
import {
  livenessOf,
  systemProcessProbe,
  type ProcessIdentity,
  type ProcessProbe,
} from "../../src/runtime/process-probe.js";
import { runLockPath } from "../../src/runtime/run-identity.js";
import {
  RUN_LOCK_RESOURCE,
  acquireRunLock,
  type RunLockContents,
} from "../../src/runtime/run-lock.js";

const repositories: string[] = [];

async function repository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "awcli-lock-"));
  repositories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * A stand-in for the operating system's answer about who is running.
 *
 * The three cases the lock has to tell apart cannot all be staged with real processes — the
 * important one, an id that now belongs to a *different* process, cannot be staged at all. So the
 * decision logic is driven from here, and the real probe is exercised against real processes at
 * the bottom of this file.
 */
function fakeProbe(
  self: ProcessIdentity,
  alive: readonly ProcessIdentity[] = [],
): ProcessProbe {
  const living = new Map([self, ...alive].map((identity) => [identity.pid, identity]));
  return {
    self: () => self,
    identify: (pid) => living.get(pid),
  };
}

const OPERATOR: ProcessIdentity = { pid: 4242, startedAt: 1_700_000_000_000 };
const SCHEDULER: ProcessIdentity = { pid: 4343, startedAt: 1_700_000_500_000 };

async function readLockFile(
  repositoryPath: string,
  run: string,
): Promise<RunLockContents> {
  const raw = await readFile(runLockPath(repositoryPath, run), "utf8");
  return JSON.parse(raw) as RunLockContents;
}

describe("one run per name", () => {
  it("takes the lock for a free run name and registers it for release", async () => {
    const repositoryPath = await repository();
    const stack = new DisposalStack();

    const outcome = await acquireRunLock(stack, {
      repositoryPath,
      runName: "triage",
      probe: fakeProbe(OPERATOR),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reclaimed).toBeUndefined();
    expect(stack.held).toEqual([RUN_LOCK_RESOURCE]);
    expect((await readLockFile(repositoryPath, "triage")).owner).toEqual(OPERATOR);

    const report = await stack.unwind();
    expect(report.ok).toBe(true);
    expect(report.released).toEqual([
      { name: RUN_LOCK_RESOURCE, disposition: "destroy" },
    ]);
    expect(existsSync(runLockPath(repositoryPath, "triage"))).toBe(false);
    expect(stack.leaks()).toEqual([]);
  });

  /** Scenario: Two runs of the same name cannot overlap */
  it("Two runs of the same name cannot overlap", async () => {
    const repositoryPath = await repository();
    const first = new DisposalStack();
    const second = new DisposalStack();
    // The scheduler's process is alive and can see the operator's process, which is the whole
    // point: the holder is live, so its lock is not available.
    const operatorProbe = fakeProbe(OPERATOR, [SCHEDULER]);
    const schedulerProbe = fakeProbe(SCHEDULER, [OPERATOR]);

    const held = await acquireRunLock(first, {
      repositoryPath,
      runName: "triage",
      probe: operatorProbe,
    });
    expect(held.ok).toBe(true);

    const refused = await acquireRunLock(second, {
      repositoryPath,
      runName: "triage",
      probe: schedulerProbe,
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.holder.owner).toEqual(OPERATOR);
    expect(refused.message).toContain("triage");
    expect(refused.message).toContain(String(OPERATOR.pid));

    // The first run continues undisturbed: its lock is still its own, and the refused run
    // registered nothing it would have to clean up.
    expect((await readLockFile(repositoryPath, "triage")).owner).toEqual(OPERATOR);
    expect(second.held).toEqual([]);
    expect(second.leaks()).toEqual([]);
    expect(first.held).toEqual([RUN_LOCK_RESOURCE]);

    await first.unwind();
  });

  /** Scenario: Differently named runs may overlap */
  it("Differently named runs may overlap", async () => {
    const repositoryPath = await repository();
    const triage = new DisposalStack();
    const notes = new DisposalStack();

    const first = await acquireRunLock(triage, {
      repositoryPath,
      runName: "triage",
      probe: fakeProbe(OPERATOR, [SCHEDULER]),
    });
    const second = await acquireRunLock(notes, {
      repositoryPath,
      runName: "release-notes",
      probe: fakeProbe(SCHEDULER, [OPERATOR]),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((await readLockFile(repositoryPath, "triage")).owner).toEqual(OPERATOR);
    expect((await readLockFile(repositoryPath, "release-notes")).owner).toEqual(
      SCHEDULER,
    );

    await Promise.all([triage.unwind(), notes.unwind()]);
  });

  it("refuses when the holder is this very process, rather than taking the lock twice", async () => {
    const repositoryPath = await repository();
    const probe = fakeProbe(OPERATOR);
    const stack = new DisposalStack();

    expect(
      (await acquireRunLock(stack, { repositoryPath, runName: "triage", probe })).ok,
    ).toBe(true);
    const again = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: "triage",
      probe,
    });

    expect(again.ok).toBe(false);
    await stack.unwind();
  });
});

describe("reclaiming a lock its owner no longer holds", () => {
  /** Scenario: A lock left by a killed run is reclaimed automatically */
  it("A lock left by a killed run is reclaimed automatically", async () => {
    const repositoryPath = await repository();
    const killed = new DisposalStack();

    // The run that will be killed takes the lock for real, so what is reclaimed is a lock the
    // code itself wrote rather than a fixture guess at its shape.
    await acquireRunLock(killed, {
      repositoryPath,
      runName: "triage",
      probe: fakeProbe(OPERATOR),
    });
    // A reboot: the process is gone and nothing unwound its stack, so the file is still there.
    expect(existsSync(runLockPath(repositoryPath, "triage"))).toBe(true);

    const next = new DisposalStack();
    const outcome = await acquireRunLock(next, {
      repositoryPath,
      runName: "triage",
      // OPERATOR is absent from the living, which is what "killed by a reboot" means here.
      probe: fakeProbe(SCHEDULER),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reclaimed?.reason).toBe("owner-gone");
    expect(outcome.reclaimed?.previousOwner).toEqual(OPERATOR);
    // Says it was reclaimed, and why. A silent reclamation is the failure mode: the operator
    // would have no way to tell a resumed run from a first one.
    expect(outcome.reclaimed?.message).toContain("triage");
    expect(outcome.reclaimed?.message).toMatch(/no longer running|killed|restarted/);
    expect((await readLockFile(repositoryPath, "triage")).owner).toEqual(SCHEDULER);

    await next.unwind();
  });

  /**
   * The recycled-id case. Something is running under the recorded id, so a lock that recorded
   * only the id would read as live for ever and the run name would be lost permanently.
   */
  it("does not mistake a reused process id for the original owner", async () => {
    const repositoryPath = await repository();
    const killed = new DisposalStack();
    await acquireRunLock(killed, {
      repositoryPath,
      runName: "triage",
      probe: fakeProbe(OPERATOR),
    });

    // Same pid, later start time: an unrelated process that happened to be handed the id.
    const impostor: ProcessIdentity = {
      pid: OPERATOR.pid,
      startedAt: OPERATOR.startedAt + 1_000,
    };
    const outcome = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: "triage",
      probe: fakeProbe(SCHEDULER, [impostor]),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reclaimed?.reason).toBe("owner-replaced");
    expect(outcome.reclaimed?.message).toContain("different process");
  });

  /** Scenario: A slow run keeps its lock */
  it("A slow run keeps its lock", async () => {
    const repositoryPath = await repository();
    const threeHours = 3 * 60 * 60 * 1000;
    const slow: ProcessIdentity = { pid: 5150, startedAt: Date.now() - threeHours };
    const stack = new DisposalStack();

    await acquireRunLock(stack, {
      repositoryPath,
      runName: "triage",
      probe: fakeProbe(slow),
    });
    // Backdate the lock so the only thing distinguishing this from a dead owner is that the
    // owner is alive — an implementation timing out on the file's age would evict it here.
    const aged = await readLockFile(repositoryPath, "triage");
    await writeFile(
      runLockPath(repositoryPath, "triage"),
      JSON.stringify({ ...aged, acquiredAt: Date.now() - threeHours }),
      "utf8",
    );

    const second = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: "triage",
      probe: fakeProbe(SCHEDULER, [slow]),
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.holder.owner).toEqual(slow);
    // Not reclaimed: the lock on disk is still the slow run's.
    expect((await readLockFile(repositoryPath, "triage")).owner).toEqual(slow);
  });

  /**
   * A lock is linked into place complete, so a live run cannot leave an unparseable one. Treating
   * it as live instead would make a corrupted file permanently block the run name.
   */
  it("reclaims a lock file that cannot be read as a lock, and says so", async () => {
    const repositoryPath = await repository();
    const stack = new DisposalStack();
    await acquireRunLock(stack, {
      repositoryPath,
      runName: "triage",
      probe: fakeProbe(OPERATOR),
    });
    await writeFile(runLockPath(repositoryPath, "triage"), "{ truncated", "utf8");

    const outcome = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: "triage",
      probe: fakeProbe(SCHEDULER),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reclaimed?.reason).toBe("unreadable");
    expect(outcome.reclaimed?.previousOwner).toBeUndefined();
    expect(outcome.reclaimed?.message).toContain("triage");
  });

  it("does not report a reclamation when the name was simply free", async () => {
    const repositoryPath = await repository();
    const stack = new DisposalStack();
    const outcome = await acquireRunLock(stack, {
      repositoryPath,
      runName: "triage",
      probe: fakeProbe(OPERATOR),
    });
    expect(outcome.ok && outcome.reclaimed).toBeUndefined();
    await stack.unwind();
  });
});

describe("releasing on every exit path", () => {
  it("releases the lock when the workflow body throws", async () => {
    const repositoryPath = await repository();
    const path = runLockPath(repositoryPath, "triage");

    const outcome = await withDisposal(async (stack) => {
      await acquireRunLock(stack, {
        repositoryPath,
        runName: "triage",
        probe: fakeProbe(OPERATOR),
      });
      expect(existsSync(path)).toBe(true);
      throw new Error("the workflow body blew up");
    });

    expect(outcome.result.ok).toBe(false);
    expect(outcome.unwind.ok).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("unwinds the lock last, after everything acquired under it", async () => {
    const repositoryPath = await repository();
    const released: string[] = [];

    await withDisposal(async (stack) => {
      await acquireRunLock(stack, {
        repositoryPath,
        runName: "triage",
        probe: fakeProbe(OPERATOR),
      });
      await stack.acquire({
        name: "worktree",
        open: () => "worktree",
        release: () => void released.push("worktree"),
        disposition: "preserve",
      });
    });

    expect(released).toEqual(["worktree"]);
    expect(existsSync(runLockPath(repositoryPath, "triage"))).toBe(false);
  });

  /**
   * A lock this process took can be reclaimed from under it — a suspend long enough for the probe
   * to disagree does it. Unlinking blindly would then delete a live run's lock and let a third
   * run start alongside it, which is the corruption the lock exists to prevent.
   */
  it("leaves a lock alone once it belongs to someone else", async () => {
    const repositoryPath = await repository();
    const stack = new DisposalStack();
    await acquireRunLock(stack, {
      repositoryPath,
      runName: "triage",
      probe: fakeProbe(OPERATOR),
    });

    // Another run has taken the name over in the meantime.
    const takenOver: RunLockContents = {
      run: "triage",
      owner: SCHEDULER,
      acquiredAt: Date.now(),
      host: "elsewhere",
    };
    await writeFile(
      runLockPath(repositoryPath, "triage"),
      JSON.stringify(takenOver),
      "utf8",
    );

    const report = await stack.unwind();

    expect(report.ok).toBe(true);
    expect((await readLockFile(repositoryPath, "triage")).owner).toEqual(SCHEDULER);
  });

  it("does not fail the unwind when the lock file has already gone", async () => {
    const repositoryPath = await repository();
    const stack = new DisposalStack();
    await acquireRunLock(stack, {
      repositoryPath,
      runName: "triage",
      probe: fakeProbe(OPERATOR),
    });
    await rm(runLockPath(repositoryPath, "triage"));

    const report = await stack.unwind();
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it("leaves no staging or set-aside files behind after a reclamation", async () => {
    const repositoryPath = await repository();
    await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: "triage",
      probe: fakeProbe(OPERATOR),
    });
    const stack = new DisposalStack();
    await acquireRunLock(stack, {
      repositoryPath,
      runName: "triage",
      probe: fakeProbe(SCHEDULER),
    });
    await stack.unwind();

    expect(await readdir(join(repositoryPath, ".awcli", "run", "triage"))).toEqual([]);
  });
});

/**
 * The fake probe above drives every decision; these are what keep the fake honest. The adapter is
 * the one part that cannot be substituted — if it reports a live process as gone, every lock in
 * the world reads as stale, and no amount of fake-driven testing above would show it.
 */
describe("asking the operating system who is running", () => {
  it("reports this process as alive, and the same start time each time it is asked", () => {
    const self = systemProcessProbe.self();
    expect(self.pid).toBe(process.pid);
    expect(systemProcessProbe.identify(process.pid)).toEqual(self);
    expect(livenessOf(self, systemProcessProbe)).toBe("live");
  });

  it("reports a start time consistent with how long this process has been up", () => {
    const self = systemProcessProbe.self();
    const uptimeMs = process.uptime() * 1000;
    // Three seconds of slack: the OS reports the start to the second on macOS, Linux derives it
    // from a boot time that is also only to the second, and the two readings above are not
    // simultaneous. Still tight enough to catch the failures that matter — a boot-relative value,
    // a seconds-vs-milliseconds mix-up, or an invented start time.
    expect(Date.now() - self.startedAt).toBeGreaterThan(uptimeMs - 3_000);
    expect(Date.now() - self.startedAt).toBeLessThan(uptimeMs + 3_000);
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

      const identity = systemProcessProbe.identify(pid);
      expect(identity).toBeDefined();
      if (identity === undefined) return;
      expect(livenessOf(identity, systemProcessProbe)).toBe("live");

      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;

      // A killed run's lock must read as reclaimable, which is exactly this answer.
      expect(livenessOf(identity, systemProcessProbe)).toBe("gone");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("answers nothing for an id no process can hold", () => {
    expect(systemProcessProbe.identify(0)).toBeUndefined();
    expect(systemProcessProbe.identify(-1)).toBeUndefined();
    expect(systemProcessProbe.identify(2 ** 31)).toBeUndefined();
  });
});
