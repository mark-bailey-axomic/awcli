import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DisposalStack, withDisposal } from "../../src/runtime/disposal.js";
import type {
  ProbeAnswer,
  ProcessIdentity,
  ProcessProbe,
} from "../../src/runtime/process-probe.js";
import {
  runLockPath,
  validateRunName,
  type RunName,
} from "../../src/runtime/run-identity.js";
import {
  RUN_LOCK_RESOURCE,
  acquireRunLock,
  type RunLockContents,
} from "../../src/runtime/run-lock.js";

/**
 * A validated run name, the only kind that reaches a path.
 *
 * Through the validator rather than a cast: a test that casts is a test that would keep passing if
 * validation were removed, and the branding exists precisely because unvalidated names used to
 * reach `runLockPath`.
 */
function runName(name: string): RunName {
  const result = validateRunName(name);
  if (!result.ok) throw new Error(`test used an invalid run name: ${result.message}`);
  return result.name;
}

const TRIAGE = runName("triage");
const RELEASE_NOTES = runName("release-notes");
const HERE = hostname();

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
 * decision logic is driven from here; the real probe has its own suite in process-probe.test.ts.
 */
function fakeProbe(
  self: ProcessIdentity,
  alive: readonly ProcessIdentity[] = [],
  options: {
    readonly unknown?: readonly number[];
    readonly gate?: () => Promise<void>;
    readonly gateSelf?: () => Promise<void>;
    /**
     * Answers to hand out for a pid, in order, before falling back to the default behaviour.
     *
     * For the cases where the interesting thing is that the OS's answer *changed* between two asks.
     * Without it, some wrong implementations are indistinguishable from the right one because they
     * merely take an extra turn round the acquisition loop and reach the same end state.
     */
    readonly answers?: ReadonlyMap<number, readonly ProbeAnswer[]>;
  } = {},
): ProcessProbe {
  const living = new Map([self, ...alive].map((identity) => [identity.pid, identity]));
  const queued = new Map<number, ProbeAnswer[]>(
    [...(options.answers ?? new Map<number, readonly ProbeAnswer[]>())].map(
      ([pid, list]) => [pid, [...list]],
    ),
  );
  return {
    self: async () => {
      await options.gateSelf?.();
      return self;
    },
    identify: async (pid): Promise<ProbeAnswer> => {
      // The gate is what makes the concurrency tests deterministic: a probe held open here parks
      // one acquisition at exactly the point the reclaim race used to open.
      await options.gate?.();
      const next = queued.get(pid)?.shift();
      if (next !== undefined) return next;
      if (options.unknown?.includes(pid) === true) {
        return { kind: "unknown", reason: "test: the probe was not able to answer" };
      }
      const identity = living.get(pid);
      return identity === undefined
        ? { kind: "not-found" }
        : { kind: "running", identity };
    },
  };
}

/**
 * A latch a test can hold and then release, for interleaving two acquisitions on purpose.
 *
 * `parkOnCall` lets a test choose *which* crossing to park on, which is what makes the
 * reclaim-then-refuse window reachable: parking on the second `self()` call puts an acquisition
 * between "I removed the stale lock" and "I link my own over the gap".
 */
function latch(parkOnCall = 1) {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const arrival = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let calls = 0;
  return {
    arrival,
    release,
    gate: async () => {
      calls += 1;
      if (calls !== parkOnCall) return;
      reached();
      await opened;
    },
  };
}

const OPERATOR: ProcessIdentity = { pid: 4242, startedAt: 1_700_000_000_000 };
const SCHEDULER: ProcessIdentity = { pid: 4343, startedAt: 1_700_000_500_000 };

async function readLockFile(
  repositoryPath: string,
  run: RunName,
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
      runName: TRIAGE,
      probe: fakeProbe(OPERATOR),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reclaimed).toBeUndefined();
    expect(stack.held).toEqual([RUN_LOCK_RESOURCE]);
    expect((await readLockFile(repositoryPath, TRIAGE)).owner).toEqual(OPERATOR);

    const report = await stack.unwind();
    expect(report.ok).toBe(true);
    expect(report.released).toEqual([
      { name: RUN_LOCK_RESOURCE, disposition: "destroy" },
    ]);
    expect(existsSync(runLockPath(repositoryPath, TRIAGE))).toBe(false);
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
      runName: TRIAGE,
      probe: operatorProbe,
    });
    expect(held.ok).toBe(true);

    const refused = await acquireRunLock(second, {
      repositoryPath,
      runName: TRIAGE,
      probe: schedulerProbe,
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.holder.owner).toEqual(OPERATOR);
    expect(refused.message).toContain("triage");
    expect(refused.message).toContain(String(OPERATOR.pid));

    // The first run continues undisturbed: its lock is still its own, and the refused run
    // registered nothing it would have to clean up.
    expect((await readLockFile(repositoryPath, TRIAGE)).owner).toEqual(OPERATOR);
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
      runName: TRIAGE,
      probe: fakeProbe(OPERATOR, [SCHEDULER]),
    });
    const second = await acquireRunLock(notes, {
      repositoryPath,
      runName: RELEASE_NOTES,
      probe: fakeProbe(SCHEDULER, [OPERATOR]),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((await readLockFile(repositoryPath, TRIAGE)).owner).toEqual(OPERATOR);
    expect((await readLockFile(repositoryPath, RELEASE_NOTES)).owner).toEqual(SCHEDULER);

    await Promise.all([triage.unwind(), notes.unwind()]);
  });

  it("refuses when the holder is this very process, rather than taking the lock twice", async () => {
    const repositoryPath = await repository();
    const probe = fakeProbe(OPERATOR);
    const stack = new DisposalStack();

    const first = await acquireRunLock(stack, { repositoryPath, runName: TRIAGE, probe });
    expect(first.ok).toBe(true);
    const before = await readLockFile(repositoryPath, TRIAGE);

    const secondStack = new DisposalStack();
    const again = await acquireRunLock(secondStack, {
      repositoryPath,
      runName: TRIAGE,
      probe,
    });

    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.kind).toBe("held");
    // The first lock is untouched and still registered: a self-collision must not rewrite it, and
    // the refused acquisition must not have registered anything of its own.
    expect(await readLockFile(repositoryPath, TRIAGE)).toEqual(before);
    expect(stack.held).toEqual([RUN_LOCK_RESOURCE]);
    expect(secondStack.held).toEqual([]);
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
      runName: TRIAGE,
      probe: fakeProbe(OPERATOR),
    });
    // A reboot: the process is gone and nothing unwound its stack, so the file is still there.
    expect(existsSync(runLockPath(repositoryPath, TRIAGE))).toBe(true);

    const next = new DisposalStack();
    const outcome = await acquireRunLock(next, {
      repositoryPath,
      runName: TRIAGE,
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
    expect((await readLockFile(repositoryPath, TRIAGE)).owner).toEqual(SCHEDULER);

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
      runName: TRIAGE,
      probe: fakeProbe(OPERATOR),
    });

    // Same pid, later start time: an unrelated process that happened to be handed the id.
    const impostor: ProcessIdentity = {
      pid: OPERATOR.pid,
      startedAt: OPERATOR.startedAt + 1_000,
    };
    const outcome = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
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
      runName: TRIAGE,
      probe: fakeProbe(slow),
    });
    // Backdate the lock so the only thing distinguishing this from a dead owner is that the
    // owner is alive — an implementation timing out on the file's age would evict it here.
    const aged = await readLockFile(repositoryPath, TRIAGE);
    await writeFile(
      runLockPath(repositoryPath, TRIAGE),
      JSON.stringify({ ...aged, acquiredAt: Date.now() - threeHours }),
      "utf8",
    );

    const second = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(SCHEDULER, [slow]),
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.holder.owner).toEqual(slow);
    // Not reclaimed: the lock on disk is still the slow run's.
    expect((await readLockFile(repositoryPath, TRIAGE)).owner).toEqual(slow);
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
      runName: TRIAGE,
      probe: fakeProbe(OPERATOR),
    });
    await writeFile(runLockPath(repositoryPath, TRIAGE), "{ truncated", "utf8");

    const outcome = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
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
      runName: TRIAGE,
      probe: fakeProbe(OPERATOR),
    });
    expect(outcome.ok && outcome.reclaimed).toBeUndefined();
    await stack.unwind();
  });
});

describe("releasing on every exit path", () => {
  it("releases the lock when the workflow body throws", async () => {
    const repositoryPath = await repository();
    const path = runLockPath(repositoryPath, TRIAGE);

    const outcome = await withDisposal(async (stack) => {
      await acquireRunLock(stack, {
        repositoryPath,
        runName: TRIAGE,
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
    const path = runLockPath(repositoryPath, TRIAGE);
    const released: string[] = [];

    const outcome = await withDisposal(async (stack) => {
      await acquireRunLock(stack, {
        repositoryPath,
        runName: TRIAGE,
        probe: fakeProbe(OPERATOR),
      });
      await stack.acquire({
        name: "worktree",
        open: () => "worktree",
        release: () => {
          // Recorded from inside the release, so the order asserted below is the order the
          // releases actually ran in — and the lock must still exist at this point.
          released.push(existsSync(path) ? "worktree (lock still held)" : "worktree");
        },
        disposition: "preserve",
      });
    });

    // The worktree goes first and the lock goes last, with the dispositions BR-021 states per
    // resource. Asserting the report rather than only the side effects is what makes this about
    // order, not merely about both having happened.
    expect(released).toEqual(["worktree (lock still held)"]);
    expect(outcome.unwind.released).toEqual([
      { name: "worktree", disposition: "preserve" },
      { name: RUN_LOCK_RESOURCE, disposition: "destroy" },
    ]);
    expect(existsSync(path)).toBe(false);
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
      runName: TRIAGE,
      probe: fakeProbe(OPERATOR),
    });

    // Another run has taken the name over in the meantime.
    const takenOver: RunLockContents = {
      run: "triage",
      owner: SCHEDULER,
      acquiredAt: Date.now(),
      host: HERE,
    };
    await writeFile(
      runLockPath(repositoryPath, TRIAGE),
      JSON.stringify(takenOver),
      "utf8",
    );

    const report = await stack.unwind();

    expect(report.ok).toBe(true);
    expect((await readLockFile(repositoryPath, TRIAGE)).owner).toEqual(SCHEDULER);
  });

  it("does not fail the unwind when the lock file has already gone", async () => {
    const repositoryPath = await repository();
    const stack = new DisposalStack();
    await acquireRunLock(stack, {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(OPERATOR),
    });
    await rm(runLockPath(repositoryPath, TRIAGE));

    const report = await stack.unwind();
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it("leaves no staging or set-aside files behind after a reclamation", async () => {
    const repositoryPath = await repository();
    await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(OPERATOR),
    });
    const stack = new DisposalStack();
    await acquireRunLock(stack, {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(SCHEDULER),
    });
    await stack.unwind();

    expect(await readdir(join(repositoryPath, ".awcli", "run", "triage"))).toEqual([]);
  });
});

/**
 * The one claim in this module that no test here can reach.
 *
 * Three operator-facing messages say whether anything was changed, and one of them — the terminal
 * "could not take the lock after N attempts" — needs three rounds of genuine contention to reach,
 * which is not something this suite can stage. Review found that message asserting "Nothing has
 * been changed" while a reclamation had already deleted a file, which is the same defect that was
 * fixed in the other two messages a round earlier and missed here.
 *
 * So rather than claim a gate that does not exist, this asserts the structural property that makes
 * the claim impossible to get wrong: the sentence lives in exactly one function, and every message
 * goes through it. A fourth message added with its own hardcoded copy fails here.
 */
describe("every message that claims nothing changed", () => {
  it("gets that claim from one place, so it cannot contradict a reclamation", async () => {
    const source = await readFile(
      new URL("../../src/runtime/run-lock.ts", import.meta.url),
      "utf8",
    );
    // Comments stripped: this is about what the code says to an operator, and the prose above
    // `changeNote` quotes the old wording while explaining why it was wrong.
    const code = source.replace(/\/\*[^]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // "Nothing further has been changed" is deliberately not this claim — it appears in the one
    // error that has already said what it changed — so the pattern does not match it.
    const claim = /Nothing (?:else )?has been changed/g;
    expect(code.match(claim)).toHaveLength(2);

    const changeNote = /function changeNote\([^]*?\n}/.exec(code)?.[0] ?? "";
    expect(changeNote).not.toBe("");
    expect(changeNote.match(claim)).toHaveLength(2);

    // And every message that can be issued after a reclamation takes the note rather than writing
    // its own copy. Three of them: the two refusals, and the terminal failure — which review found
    // hardcoding the claim while a reclamation had already deleted a file.
    expect(code.match(/changeNote\(reclaimed\)/g)).toHaveLength(3);
    expect(code).toMatch(
      /after \$\{MAX_ATTEMPTS\} attempts[^`]*\$\{changeNote\(reclaimed\)\}/,
    );
  });
});

/**
 * Where the first version of this unit was wrong, and where its suite could not look.
 *
 * Every other test here is sequential, and both of the lock's interesting properties —
 * link-from-staging and verified removal — exist only to survive concurrency. So a race was
 * green: two runs meeting the same stale lock after a reboot, which is the ordinary case
 * reclamation exists for, could both come away holding the name.
 *
 * These reproduce it deterministically rather than by repetition, by holding a probe open at the
 * exact point the window used to be. A stress loop that hopes to hit a millisecond-wide race is
 * not a regression test; a latch is.
 */
describe("two runs racing for the same lock", () => {
  /**
   * The blocking defect. B judges the stale lock, and while B is still inside the probe, A
   * reclaims it and links its own live lock into place. B must not then remove A's lock — which is
   * what removing "whatever is at the path" does.
   */
  it("does not reclaim a live lock that replaced the one it judged", async () => {
    const repositoryPath = await repository();
    const dead: ProcessIdentity = { pid: 9001, startedAt: 1_600_000_000_000 };

    // A killed run's lock, written by the real code path.
    await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(dead),
    });

    const held = latch();
    const secondStack = new DisposalStack();
    const second = acquireRunLock(secondStack, {
      repositoryPath,
      runName: TRIAGE,
      // Parked inside the liveness question, holding the verdict "the dead owner is gone" — and
      // able to see OPERATOR as alive, so what it does next is about the race and not about a
      // probe that cannot see the winner.
      probe: fakeProbe(SCHEDULER, [OPERATOR], { gate: held.gate }),
    });

    await held.arrival;

    // Meanwhile the first run reclaims and takes the name.
    const firstStack = new DisposalStack();
    const first = await acquireRunLock(firstStack, {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(OPERATOR),
    });
    expect(first.ok).toBe(true);
    expect(first.ok && first.reclaimed?.reason).toBe("owner-gone");

    held.release();
    const outcome = await second;

    // Exactly one holder, and it is the one that won.
    expect(outcome.ok).toBe(false);
    expect((await readLockFile(repositoryPath, TRIAGE)).owner).toEqual(OPERATOR);
    expect(firstStack.held).toEqual([RUN_LOCK_RESOURCE]);
    expect(secondStack.held).toEqual([]);
    expect(secondStack.leaks()).toEqual([]);

    await firstStack.unwind();
  });

  /**
   * The same interleaving, with the loser's own reclamation to account for. It destroyed a stale
   * lock before losing the race, and BR-035 has no exception for a reclamation that was followed
   * by a refusal.
   */
  it("reports a reclamation it made even when it goes on to be refused", async () => {
    const repositoryPath = await repository();
    const dead: ProcessIdentity = { pid: 9002, startedAt: 1_600_000_000_000 };
    await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(dead),
    });

    // Parked on its *second* self() call: past the reclamation, before linking its own lock.
    const afterReclaim = latch(2);
    const loser = acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(SCHEDULER, [OPERATOR], { gateSelf: afterReclaim.gate }),
    });
    await afterReclaim.arrival;
    // The stale lock is gone: the parked run destroyed it and has not yet replaced it.
    expect(existsSync(runLockPath(repositoryPath, TRIAGE))).toBe(false);

    // Another run takes the free name in that gap.
    const winnerStack = new DisposalStack();
    const winner = await acquireRunLock(winnerStack, {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(OPERATOR),
    });
    expect(winner.ok).toBe(true);
    expect(winner.ok && winner.reclaimed).toBeUndefined();

    afterReclaim.release();
    const outcome = await loser;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("held");
    // It destroyed a stale lock and then lost the name. BR-035 has no exception for that, so the
    // reclamation is still reported — and the refusal must not also claim nothing changed.
    expect(outcome.reclaimed?.reason).toBe("owner-gone");
    expect(outcome.reclaimed?.previousOwner).toEqual(dead);
    expect(outcome.message).toContain("Reclaimed a stale lock");
    expect(outcome.message).not.toContain("Nothing has been changed.");
    expect(outcome.message).toContain("Nothing else has been changed.");

    await winnerStack.unwind();
  });

  it("gives the name to exactly one of many simultaneous runs", async () => {
    const repositoryPath = await repository();
    const contenders = Array.from({ length: 8 }, (_, index) => ({
      identity: { pid: 7000 + index, startedAt: 1_700_000_000_000 + index },
      stack: new DisposalStack(),
    }));
    const everyone = contenders.map((c) => c.identity);

    const outcomes = await Promise.all(
      contenders.map((c) =>
        acquireRunLock(c.stack, {
          repositoryPath,
          runName: TRIAGE,
          probe: fakeProbe(c.identity, everyone),
        }),
      ),
    );

    const winners = outcomes.filter((outcome) => outcome.ok);
    expect(winners).toHaveLength(1);
    const onDisk = await readLockFile(repositoryPath, TRIAGE);
    expect(winners[0]?.ok === true && winners[0].lock.contents.owner).toEqual(
      onDisk.owner,
    );

    // Every contender that was refused registered nothing, so it has nothing to release and
    // nothing to leak. The winner is holding the lock, which is not a leak until it unwinds.
    const refusedStacks = contenders.filter((_, index) => outcomes[index]?.ok !== true);
    expect(refusedStacks).toHaveLength(contenders.length - 1);
    for (const contender of refusedStacks) {
      expect(contender.stack.held).toEqual([]);
      expect(contender.stack.leaks()).toEqual([]);
    }

    await Promise.all(contenders.map((c) => c.stack.unwind()));
    for (const contender of contenders) expect(contender.stack.leaks()).toEqual([]);
    expect(existsSync(runLockPath(repositoryPath, TRIAGE))).toBe(false);
  });

  it("hands the name on cleanly when runs contend in sequence", async () => {
    const repositoryPath = await repository();
    for (let round = 0; round < 5; round++) {
      const stack = new DisposalStack();
      const outcome = await acquireRunLock(stack, {
        repositoryPath,
        runName: TRIAGE,
        probe: fakeProbe({ pid: 8000 + round, startedAt: 1_700_000_000_000 + round }),
      });
      expect(outcome.ok).toBe(true);
      // Released normally, so the next round finds a free name rather than a stale lock.
      expect(outcome.ok && outcome.reclaimed).toBeUndefined();
      await stack.unwind();
    }
    expect(existsSync(runLockPath(repositoryPath, TRIAGE))).toBe(false);
  });
});

/**
 * The paths where awcli cannot establish where the owner is. All of them refuse. A refusal costs a
 * retry; a wrong reclamation costs the corruption the lock exists to prevent.
 */
describe("refusing rather than guessing", () => {
  it("refuses when the probe cannot answer, instead of reading the owner as gone", async () => {
    const repositoryPath = await repository();
    const owner: ProcessIdentity = { pid: 9100, startedAt: 1_700_000_000_000 };
    const first = new DisposalStack();
    await acquireRunLock(first, {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(owner),
    });

    const outcome = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      // `ps` timed out, or was missing from the image. Not the same as "nothing holds that id".
      probe: fakeProbe(SCHEDULER, [], { unknown: [owner.pid] }),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("undecidable");
    expect(outcome.message).toContain("could not be established");
    // Untouched: the live run still holds its lock.
    expect((await readLockFile(repositoryPath, TRIAGE)).owner).toEqual(owner);
    await first.unwind();
  });

  /**
   * A pid means nothing outside the machine that issued it. The first version of this unit probed
   * another host's pid against the local process table and told the operator its owner "was
   * killed", which was false — and the `host` field it wrote existed to explain exactly this case.
   */
  it("refuses a lock taken on another machine rather than reclaiming it", async () => {
    const repositoryPath = await repository();
    const path = runLockPath(repositoryPath, TRIAGE);
    await mkdir(dirname(path), { recursive: true });
    const elsewhere: RunLockContents = {
      run: "triage",
      // An id that does not exist here, which is what makes this a reclamation if host is ignored.
      owner: { pid: 999_999, startedAt: 1_700_000_000_000 },
      acquiredAt: Date.now(),
      host: "another-machine",
    };
    await writeFile(path, JSON.stringify(elsewhere), "utf8");

    const outcome = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(OPERATOR),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("undecidable");
    expect(outcome.message).toContain("another-machine");
    expect(outcome.reclaimed).toBeUndefined();
    // Not reclaimed, and not rewritten.
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(elsewhere);
  });

  /**
   * A repository can carry a committed symlink at the lock path. Following it would put the lock,
   * and the removal of the lock, wherever it points — and a dangling one answers EEXIST to `link`
   * and ENOENT to `readFile` at the same time, which is the pair the acquisition loop used to spin
   * on for ever. This test times out rather than fails if that bound is removed.
   */
  /**
   * The re-judge inside a reclamation must make the same call the acquisition path makes. It used
   * to be looser in both directions at once, and this is the dangerous half: a lock from another
   * host counted as *stale*, so a reclamation that took it aside deleted it — while the acquisition
   * path refuses to judge another machine's pid at all.
   */
  it("puts back a lock from another machine that a reclamation took aside", async () => {
    const repositoryPath = await repository();
    const path = runLockPath(repositoryPath, TRIAGE);
    const dead: ProcessIdentity = { pid: 9300, startedAt: 1_600_000_000_000 };
    await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(dead),
    });

    const parked = latch();
    const reclaimer = acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(SCHEDULER, [], { gate: parked.gate }),
    });
    await parked.arrival;

    // While it is parked, the file it judged is replaced by a lock from another machine.
    const elsewhere: RunLockContents = {
      run: "triage",
      owner: { pid: 999_999, startedAt: 1_700_000_000_000 },
      acquiredAt: Date.now(),
      host: "another-machine",
    };
    const foreign = JSON.stringify(elsewhere);
    await writeFile(path, foreign, "utf8");
    parked.release();

    const outcome = await reclaimer;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("undecidable");
    // Put back byte for byte, not deleted.
    expect(await readFile(path, "utf8")).toBe(foreign);
  });

  /**
   * The other direction of the same defect: a recycled process id counted as *live* in the
   * re-judge, so a genuinely abandoned lock was put back and the attempt spun instead of
   * reclaiming it. And the reclamation reports the lock it actually removed, which on this path is
   * not the one it originally judged.
   */
  /**
   * The other direction of the same defect: a recycled process id counted as *live* in the
   * re-judge, so a genuinely abandoned lock was put back and the attempt spun instead of
   * reclaiming it. And the reclamation reports the lock it actually removed, which on this path is
   * not the one it originally judged.
   *
   * The probe stops being able to answer about that pid after the first ask, which is what makes
   * this discriminating: an implementation that puts the lock back and tries again gets
   * "undecidable" on its second ask and refuses, where the correct one has already reclaimed. Two
   * implementations differing only by a wasted turn round the loop would otherwise reach the same
   * end state, and no assertion here could tell them apart.
   */
  it("reclaims a recycled-pid lock that a reclamation took aside, and reports that one", async () => {
    const repositoryPath = await repository();
    const path = runLockPath(repositoryPath, TRIAGE);
    const dead: ProcessIdentity = { pid: 9400, startedAt: 1_600_000_000_000 };
    await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(dead),
    });

    // A lock whose recorded pid is held by a process that started later: the owner is gone.
    const recycled: ProcessIdentity = { pid: 9500, startedAt: 1_650_000_000_000 };
    const impostor: ProcessIdentity = { pid: 9500, startedAt: 1_700_000_777_000 };

    const parked = latch();
    const stack = new DisposalStack();
    const reclaimer = acquireRunLock(stack, {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(SCHEDULER, [], {
        gate: parked.gate,
        answers: new Map<number, readonly ProbeAnswer[]>([
          [
            recycled.pid,
            [
              { kind: "running", identity: impostor },
              { kind: "unknown", reason: "test: the probe stopped answering" },
            ],
          ],
        ]),
      }),
    });
    await parked.arrival;

    await writeFile(
      path,
      JSON.stringify({
        run: "triage",
        owner: recycled,
        acquiredAt: Date.now(),
        host: HERE,
      }),
      "utf8",
    );
    parked.release();

    const outcome = await reclaimer;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The verdict is about the lock actually removed — the recycled-pid one — not about the dead
    // owner that was judged before the swap.
    expect(outcome.reclaimed?.reason).toBe("owner-replaced");
    expect(outcome.reclaimed?.previousOwner).toEqual(recycled);
    expect(outcome.reclaimed?.message).toContain("different process");
    expect((await readLockFile(repositoryPath, TRIAGE)).owner).toEqual(SCHEDULER);
    await stack.unwind();
  });

  it("refuses a symlink at the lock path instead of spinning on it", async () => {
    const repositoryPath = await repository();
    const path = runLockPath(repositoryPath, TRIAGE);
    await mkdir(dirname(path), { recursive: true });
    await symlink(join(repositoryPath, "nowhere", "target"), path);

    await expect(
      acquireRunLock(new DisposalStack(), {
        repositoryPath,
        runName: TRIAGE,
        probe: fakeProbe(OPERATOR),
      }),
    ).rejects.toThrow(/symbolic link/);
  });

  /**
   * The symlink does not have to be at the lock path to redirect it. `mkdir` with `recursive`
   * follows an existing symlink at any level, so a repository carrying a committed symlink at
   * `.awcli` or `.awcli/run` had its run directory and its lock created outside the repository —
   * and the check that looked only at the run directory saw a real directory there and passed.
   */
  it.each([
    { label: ".awcli", segments: [".awcli"] },
    { label: ".awcli/run", segments: [".awcli", "run"] },
  ])(
    "refuses a symlink at $label, which would put the lock outside the repository",
    async ({ segments }) => {
      const repositoryPath = await repository();
      const outside = await mkdtemp(join(tmpdir(), "awcli-outside-"));
      const linkAt = join(repositoryPath, ...segments);
      await mkdir(dirname(linkAt), { recursive: true });
      await symlink(outside, linkAt);

      await expect(
        acquireRunLock(new DisposalStack(), {
          repositoryPath,
          runName: TRIAGE,
          probe: fakeProbe(OPERATOR),
        }),
      ).rejects.toThrow(/symbolic link/);

      // And nothing was written through it: the whole point is that the lock never lands here.
      expect(await readdir(outside)).toEqual([]);
      await rm(outside, { recursive: true, force: true });
    },
  );

  /**
   * The ancestor walk must inspect the repository's own `.awcli` and below, and nothing else.
   *
   * `--repo /repo/` — a trailing separator, which shell completion supplies — used to defeat the
   * walk's stopping condition, because it compared against the repository path as a string and
   * `/repo` never equals `/repo/`. The walk then carried on past the repository. This stages a
   * symlink *above* the repository, so an implementation that walks out refuses a run it has no
   * business refusing; the layout is derived forwards now, so there is no condition to get wrong.
   */
  it.each([
    { label: "no trailing separator", suffix: "" },
    { label: "a trailing separator", suffix: sep },
  ])("ignores a symlink above the repository, given $label", async ({ suffix }) => {
    const parent = await mkdtemp(join(tmpdir(), "awcli-above-"));
    const real = join(parent, "real");
    const viaLink = join(parent, "link");
    await mkdir(join(real, "repo"), { recursive: true });
    // `<parent>/link` is a symlink, and the repository is reached through it.
    await symlink(real, viaLink);
    const repositoryPath = join(viaLink, "repo") + suffix;

    try {
      const stack = new DisposalStack();
      const outcome = await acquireRunLock(stack, {
        repositoryPath,
        runName: TRIAGE,
        probe: fakeProbe(OPERATOR),
      });

      expect(outcome.ok).toBe(true);
      expect(existsSync(runLockPath(repositoryPath, TRIAGE))).toBe(true);
      await stack.unwind();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked run directory", async () => {
    const repositoryPath = await repository();
    const path = runLockPath(repositoryPath, TRIAGE);
    const outside = join(repositoryPath, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(dirname(dirname(path)), { recursive: true });
    await symlink(outside, dirname(path));

    await expect(
      acquireRunLock(new DisposalStack(), {
        repositoryPath,
        runName: TRIAGE,
        probe: fakeProbe(OPERATOR),
      }),
    ).rejects.toThrow(/symbolic link/);
  });
});

/**
 * How many stale locks the competitor in the test below plants: one for each attempt the
 * acquisition is allowed, so every round it takes ends in a reclamation and none in a lock.
 */
const MAX_PLANTINGS = 3;

describe("a reclamation on the last attempt", () => {
  /**
   * The loop as first written fell straight out of its final round: if that round reclaimed a
   * stale lock, the file was deleted, the path was left free, no lock was taken, and the operator
   * was told the name was "being taken and released repeatedly by other processes" — while nothing
   * held it at all. The reclamation was both wasted and misreported.
   */
  it("is used rather than discarded, so the run gets the name it just freed", async () => {
    const repositoryPath = await repository();
    const path = runLockPath(repositoryPath, TRIAGE);

    let plantings = 0;
    const probe: ProcessProbe = {
      // Plants a fresh stale lock immediately before each of the first three creates, and then
      // stops. Every attempt therefore finds a lock, judges it stale and reclaims it; the path is
      // free after the last one and only the create is missing.
      self: async () => {
        if (plantings < MAX_PLANTINGS) {
          plantings += 1;
          await mkdir(dirname(path), { recursive: true });
          await writeFile(
            path,
            `${JSON.stringify({
              run: TRIAGE,
              // A different start time each round, so the bytes differ and no round could be
              // passing by reusing an earlier judgement.
              owner: { pid: 9500, startedAt: 1_600_000_000_000 + plantings },
              acquiredAt: Date.now(),
              host: HERE,
            })}\n`,
            "utf8",
          );
        }
        return OPERATOR;
      },
      identify: async (pid): Promise<ProbeAnswer> =>
        pid === OPERATOR.pid
          ? { kind: "running", identity: OPERATOR }
          : { kind: "not-found" },
    };

    const outcome = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      probe,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reclaimed?.reason).toBe("owner-gone");
    expect((await readLockFile(repositoryPath, TRIAGE)).owner).toEqual(OPERATOR);
  });
});

describe("printing what a lock file says", () => {
  /** Anything a terminal would act on rather than display. */
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

  async function plant(
    repositoryPath: string,
    contents: Record<string, unknown>,
  ): Promise<void> {
    const path = runLockPath(repositoryPath, TRIAGE);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(contents)}\n`, "utf8");
  }

  /**
   * The lock is a file in the repository, so a commit can put anything in it. Escape sequences in
   * `host` went straight to the terminal, which means a repository could show an operator a
   * refusal that says whatever it likes — including one that looks like it came from awcli.
   */
  it("strips what a terminal would act on out of a hostname", async () => {
    const repositoryPath = await repository();
    await plant(repositoryPath, {
      run: "triage",
      owner: { pid: 12_345, startedAt: 1_600_000_000_000 },
      acquiredAt: Date.now(),
      host: "\u001b[2J\u001b[1;31mattacker",
    });

    const outcome = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(OPERATOR),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("undecidable");
    expect(outcome.message).not.toMatch(CONTROL);
    // Still says which host, so the operator can act on it.
    expect(outcome.message).toContain("attacker");
  });

  /**
   * `new Date(x).toISOString()` throws RangeError out of range, and `acquiredAt` is a number off
   * disk. A refusal that throws while formatting itself reaches the operator as a stack trace
   * instead of as the reason their run will not start.
   */
  it("says a lock's acquisition time is unreadable instead of throwing on it", async () => {
    const repositoryPath = await repository();
    await plant(repositoryPath, {
      run: "triage",
      owner: OPERATOR,
      acquiredAt: 1e21,
      host: HERE,
    });

    const outcome = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      probe: fakeProbe(SCHEDULER, [OPERATOR]),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("held");
    expect(outcome.message).toContain("an unreadable time");
  });
});
