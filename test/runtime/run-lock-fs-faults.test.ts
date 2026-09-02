import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProbeAnswer,
  ProcessIdentity,
  ProcessProbe,
} from "../../src/runtime/process-probe.js";

/**
 * The failures `run-lock.test.ts` cannot stage against a real filesystem.
 *
 * A write that fails *part-way through*, a `link` the filesystem refuses, an `unlink` that faults:
 * there is no portable way to fill a disk, remount read-only or fault a device from a test, and
 * every one of those is a path where this unit either loses a live run's lock or turns a lock it
 * took into an error. So this file substitutes the individual calls, one assertion at a time. It
 * lives apart from the main lock suite because the module mock is hoisted over the whole file, and
 * the rest of that suite must run against a real filesystem or it proves nothing.
 */

/**
 * Set by a test to make a staging write create its file and then fail.
 *
 * `after` skips that many writes first, for the failures that have to land on a *later* attempt
 * than the first — a reclamation has to happen before there is anything for the failure to report.
 */
let failNextWrite: { readonly code: string; readonly after?: number } | undefined;
/** Set by a test to fail the `link` that puts a displaced lock back. */
let failRestoringLink: { readonly code: string } | undefined;
/** Set by a test to fail every `link`, as a filesystem without hard links does. */
let failEveryLink: { readonly code: string } | undefined;
/**
 * Set by a test to fail the first `remaining` attempts to link a lock into place, with EEXIST.
 *
 * What a name being taken and released under this run looks like: the create is refused because
 * something is there, and it has gone again by the time the lock is read. Not `failEveryLink`,
 * which also fails the restore and the rescue create — the point here is that a *bounded* run of
 * them ends with the lock taken rather than with a report of contention.
 */
let failLinkTimes: { readonly code: string; remaining: number } | undefined;
/** Set by a test to fail the tidy-up of a staging file whose lock is already linked into place. */
let failStagingUnlink: { readonly code: string } | undefined;
/** Set by a test to fail the removal of a set-aside file after a reclamation has already happened. */
let failAsideUnlink: { readonly code: string } | undefined;
/** Set by a test to fail the `mkdir` that creates the run directory. */
let failNextMkdir: { readonly code: string } | undefined;
/** Set by a test to fail the read of whatever is at the lock path. */
let failLockRead: { readonly code: string } | undefined;
/** Set by a test to fail the read of a lock that has just been renamed aside. */
let failAsideRead: { readonly code: string } | undefined;
/**
 * Set by a test to put a lock at the lock path just before a set-aside file is unlinked.
 *
 * The one window in an acquisition that no probe crosses: the reclaiming attempt removes the file it
 * judged and then links its own lock, with nothing in between that a fake probe can park inside. A
 * third process winning that gap is what makes a reclamation end in a refusal, and BR-035 has no
 * exception for it, so it needs staging from the filesystem side. This test file exists for exactly
 * the windows the real-filesystem suite cannot reach.
 */
let plantOnAsideUnlink: string[] = [];

function faulted(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    mkdir: async (
      directory: Parameters<typeof real.mkdir>[0],
      options?: Parameters<typeof real.mkdir>[1],
    ) => {
      if (failNextMkdir !== undefined) {
        const failure = failNextMkdir;
        failNextMkdir = undefined;
        throw faulted(failure.code);
      }
      return real.mkdir(directory, options);
    },
    writeFile: async (
      file: Parameters<typeof real.writeFile>[0],
      data: Parameters<typeof real.writeFile>[1],
      options?: Parameters<typeof real.writeFile>[2],
    ) => {
      const failure = failNextWrite;
      if (failure === undefined) return real.writeFile(file, data, options);
      if (failure.after !== undefined && failure.after > 0) {
        failNextWrite = { code: failure.code, after: failure.after - 1 };
        return real.writeFile(file, data, options);
      }
      failNextWrite = undefined;
      // Create the file, as the real `wx` open would, then fail as a mid-write error does.
      await real.writeFile(file, "", { flag: "wx", mode: 0o600 });
      throw faulted(failure.code);
    },
    link: async (
      existing: Parameters<typeof real.link>[0],
      next: Parameters<typeof real.link>[1],
    ) => {
      if (failEveryLink !== undefined) throw faulted(failEveryLink.code);
      // Only the links that put a *lock* in place; the restore's source is a set-aside file.
      if (
        failLinkTimes !== undefined &&
        failLinkTimes.remaining > 0 &&
        !String(existing).includes(".stale.")
      ) {
        failLinkTimes.remaining -= 1;
        throw faulted(failLinkTimes.code);
      }
      // The restore is the only `link` whose source is a set-aside lock.
      if (failRestoringLink !== undefined && String(existing).includes(".stale.")) {
        const failure = failRestoringLink;
        failRestoringLink = undefined;
        throw faulted(failure.code);
      }
      return real.link(existing, next);
    },
    readFile: async (
      file: Parameters<typeof real.readFile>[0],
      options?: Parameters<typeof real.readFile>[1],
    ) => {
      // The aside is the first path with `.stale.` in it that an acquisition reads: the leftover
      // scan reads them too, but its first pass runs before any aside exists. One-shot, so a test
      // faults exactly that read and the scan sees the file normally afterwards.
      if (failAsideRead !== undefined && String(file).includes(".stale.")) {
        const failure = failAsideRead;
        failAsideRead = undefined;
        throw faulted(failure.code);
      }
      if (failLockRead !== undefined && String(file).endsWith("/lock")) {
        const failure = failLockRead;
        failLockRead = undefined;
        throw faulted(failure.code);
      }
      return options === undefined ? real.readFile(file) : real.readFile(file, options);
    },
    unlink: async (target: Parameters<typeof real.unlink>[0]) => {
      if (plantOnAsideUnlink.length > 0 && String(target).includes(".stale.")) {
        const bytes = plantOnAsideUnlink.shift() as string;
        // `wx`, so a mistake in this fake shows up as an error rather than as a silent overwrite of
        // whatever the code under test had put there.
        await real.writeFile(String(target).replace(/\.stale\.[^/]*$/, ""), bytes, {
          flag: "wx",
          mode: 0o600,
        });
      }
      if (failStagingUnlink !== undefined && String(target).includes(".staging.")) {
        const failure = failStagingUnlink;
        failStagingUnlink = undefined;
        throw faulted(failure.code);
      }
      if (failAsideUnlink !== undefined && String(target).includes(".stale.")) {
        const failure = failAsideUnlink;
        failAsideUnlink = undefined;
        throw faulted(failure.code);
      }
      return real.unlink(target);
    },
  };
});

const { DisposalStack } = await import("../../src/runtime/disposal.js");
const { runLockPath, validateRunName } =
  await import("../../src/runtime/run-identity.js");
const { acquireRunLock } = await import("../../src/runtime/run-lock.js");

const repositories: string[] = [];
afterEach(async () => {
  failNextWrite = undefined;
  failRestoringLink = undefined;
  failEveryLink = undefined;
  failStagingUnlink = undefined;
  failAsideRead = undefined;
  failLinkTimes = undefined;
  plantOnAsideUnlink = [];
  failAsideUnlink = undefined;
  failNextMkdir = undefined;
  failLockRead = undefined;
  await Promise.all(
    repositories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function runName(name: string) {
  const result = validateRunName(name);
  if (!result.ok) throw new Error(result.message);
  return result.name;
}

describe("a staging write that fails part-way through", () => {
  it("leaves no staging file behind, and reports the failure", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-staging-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    const runDirectory = dirname(runLockPath(repositoryPath, triage));

    failNextWrite = { code: "ENOSPC" };

    await expect(
      acquireRunLock(new DisposalStack(), {
        repositoryPath,
        runName: triage,
        probe: {
          self: () => Promise.resolve({ pid: 4242, startedAt: 1_700_000_000_000 }),
          identify: () => Promise.resolve({ kind: "not-found" as const }),
        },
      }),
    ).rejects.toThrow(/ENOSPC/);

    // The whole point: nothing accumulates in the run's directory for someone to puzzle over later.
    expect(await readdir(runDirectory)).toEqual([]);
  });
});

describe("a run directory that cannot be created", () => {
  /**
   * The other half of the unwritable-repository message, and the one its own docblock names first:
   * `mkdir` fails before the staging write is ever reached, which is what happens when `.awcli` does
   * not exist yet. Only the staging-write half had a test, so deleting this call site left the suite
   * green and an operator whose repository is read-only back to a bare errno.
   */
  it("is explained in terms of the directory too, not only the write", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-mkdir-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    failNextMkdir = { code: "EROFS" };

    const failure = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: triage,
      probe: {
        self: () => Promise.resolve(OPERATOR),
        identify: () => Promise.resolve({ kind: "not-found" as const }),
      },
    }).catch((error: unknown) => error);

    expect(String(failure)).toContain("not writable");
    expect(String(failure)).toContain(dirname(runLockPath(repositoryPath, triage)));
  });
});

describe("a lock this user cannot read", () => {
  /**
   * A lock is created 0600, so a run started by another account leaves one this user cannot read at
   * all. `readLock` rethrew everything that was not ENOENT, so it arrived as a bare EACCES and a
   * stack trace — for the one situation on this path that is not a fault at all but an ordinary run
   * in progress under another user.
   */
  it("is explained as a run under another account, not as an errno", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-unreadable-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    const path = runLockPath(repositoryPath, triage);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, lockBytes(RUNNING), "utf8");
    failLockRead = { code: "EACCES" };

    const failure = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: triage,
      probe: {
        self: () => Promise.resolve(OPERATOR),
        identify: () => Promise.resolve({ kind: "not-found" as const }),
      },
    }).catch((error: unknown) => error);

    expect(String(failure)).toContain("another account");
    expect(String(failure)).toContain(path);
  });
});

describe("a reclamation whose tidying up fails", () => {
  /**
   * The set-aside file is unlinked *after* the removal has already succeeded, so a failure there
   * must not become the outcome: the lock is reclaimed either way, and turning a completed
   * reclamation into a thrown errno would leave the run refusing to start over litter it made
   * itself. `ignoreMissing` here — which is what the sibling call sites used — rethrows everything
   * that is not ENOENT and does exactly that.
   */
  it("does not turn a completed reclamation into a failure", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-aside-tidy-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    const path = runLockPath(repositoryPath, triage);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, lockBytes(DEAD), "utf8");
    failAsideUnlink = { code: "EIO" };

    const stack = new DisposalStack();
    const outcome = await acquireRunLock(stack, {
      repositoryPath,
      runName: triage,
      probe: {
        self: () => Promise.resolve(OPERATOR),
        identify: () => Promise.resolve({ kind: "not-found" as const }),
      },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.reclaimed?.reason).toBe("owner-gone");
    expect(await readFile(path, "utf8")).toContain(`"pid": ${OPERATOR.pid}`);
    await stack.unwind();
  });
});

describe("leftovers whose owners are gone", () => {
  /**
   * Each costs a read and, on macOS, a `ps` spawn. The scan runs on every attempt now, so a
   * repository that has met a failed restore a few times would pay for all of them three times over
   * on the startup path of every run of that name. A dead process does not come back, so an inert
   * leftover stays inert for the length of an acquisition and is judged once.
   */
  it("are read and probed once per acquisition, not once per attempt", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-inert-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    const path = runLockPath(repositoryPath, triage);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      `${path}.stale.11111111-1111-4111-8111-111111111111`,
      lockBytes(DEAD),
      "utf8",
    );

    // Every create is refused and every read then finds nothing, so all three attempts run.
    failLinkTimes = { code: "EEXIST", remaining: MAX_ATTEMPTS };
    let asked = 0;

    const stack = new DisposalStack();
    const outcome = await acquireRunLock(stack, {
      repositoryPath,
      runName: triage,
      probe: {
        self: () => Promise.resolve(OPERATOR),
        identify: (pid) => {
          if (pid === DEAD.pid) asked += 1;
          return Promise.resolve({ kind: "not-found" as const });
        },
      },
    });

    expect(outcome.ok).toBe(true);
    expect(asked).toBe(1);
    await stack.unwind();
  });
});

describe("a repository this user cannot write to", () => {
  /**
   * The one failure on this path an operator can fix without knowing anything about awcli, and it
   * reached them as a bare `EACCES` and a stack trace until review pointed that out. The remedy is
   * about the directory, so the message has to name it.
   */
  it("is explained in terms of the directory, not as an errno", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-perm-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    failNextWrite = { code: "EACCES" };

    await expect(
      acquireRunLock(new DisposalStack(), {
        repositoryPath,
        runName: triage,
        probe: {
          self: () => Promise.resolve({ pid: 4242, startedAt: 1_700_000_000_000 }),
          identify: () => Promise.resolve({ kind: "not-found" as const }),
        },
      }),
    ).rejects.toThrow(/not writable/);

    // Naming the directory is the point: an errno does not say which one to look at.
    failNextWrite = { code: "EACCES" };
    const failure = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: triage,
      probe: {
        self: () => Promise.resolve({ pid: 4242, startedAt: 1_700_000_000_000 }),
        identify: () => Promise.resolve({ kind: "not-found" as const }),
      },
    }).catch((error: unknown) => error);
    expect(String(failure)).toContain(dirname(runLockPath(repositoryPath, triage)));
  });
});

const HERE = hostname();
const OPERATOR: ProcessIdentity = { pid: 4242, startedAt: 1_700_000_000_000 };
const RUNNING: ProcessIdentity = { pid: 4343, startedAt: 1_700_000_500_000 };
const DEAD: ProcessIdentity = { pid: 9500, startedAt: 1_600_000_000_000 };
/** A second dead owner, for the acquisition that has two stale locks to get through. */
const DEAD_AGAIN: ProcessIdentity = { pid: 9501, startedAt: 1_600_000_001_000 };

function lockBytes(owner: ProcessIdentity): string {
  return `${JSON.stringify({
    run: "triage",
    owner,
    acquiredAt: 1_700_000_900_000,
    host: HERE,
  })}\n`;
}

/** A probe that parks on its first `identify`, so a test can change the file under it. */
function parkingProbe(): {
  readonly probe: ProcessProbe;
  readonly arrival: Promise<void>;
  readonly release: () => void;
} {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const arrival = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let asks = 0;
  return {
    arrival,
    release,
    probe: {
      self: async () => OPERATOR,
      identify: async (pid): Promise<ProbeAnswer> => {
        asks += 1;
        if (asks === 1) {
          reached();
          await opened;
        }
        if (pid === RUNNING.pid) return { kind: "running", identity: RUNNING };
        if (pid === OPERATOR.pid) return { kind: "running", identity: OPERATOR };
        return { kind: "not-found" };
      },
    },
  };
}

describe("a lock that was set aside and cannot be put back", () => {
  /**
   * The reclaim path renames the lock aside before it can verify what it took. When the file turns
   * out to be a *live* lock that replaced the one that was judged, it has to go back — and the
   * first version of this code put the `unlink` of the set-aside copy in a `finally`, which runs on
   * the throw paths too. So a restore that failed for any reason at all ended with the live lock
   * deleted rather than merely displaced, the path free, and the next run taking the name alongside
   * a process still working under it. That is the BR-010 double-writer this function exists to
   * prevent, reached through the error handling of the fix for it.
   */
  it.each([
    { code: "ENOSPC", expected: /could not put it back/ },
    // The EEXIST half had neither a test nor a mutation for a long time: only ENOSPC was staged
    // here, and the gate anchored on the *other* throw's text — so putting the
    // `unlink` back in front of this one would have destroyed a live lock again with every test and
    // every mutation still green. It is the more likely of the two failures, as well: it is what a
    // third process linking its own lock into the gap looks like from here.
    { code: "EEXIST", expected: /replaced by another process/ },
  ])(
    "is left on disk rather than deleted when the restore fails with $code",
    async ({ code, expected }) => {
      const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-restore-"));
      repositories.push(repositoryPath);
      const triage = runName("triage");
      const path = runLockPath(repositoryPath, triage);
      const runDirectory = dirname(path);

      // A stale lock for the acquisition to judge.
      await mkdir(runDirectory, { recursive: true });
      await writeFile(path, lockBytes(DEAD), "utf8");

      const parked = parkingProbe();
      const acquiring = acquireRunLock(new DisposalStack(), {
        repositoryPath,
        runName: triage,
        probe: parked.probe,
      });
      await parked.arrival;

      // Replaced, while the acquisition is parked mid-judgement, by a lock whose owner is running.
      const live = lockBytes(RUNNING);
      await writeFile(path, live, "utf8");
      failRestoringLink = { code };
      parked.release();

      await expect(acquiring).rejects.toThrow(expected);

      // The live lock's bytes are still on disk somewhere, under the set-aside name the message named.
      const entries = await readdir(runDirectory);
      const setAside = entries.filter((entry) => entry.includes(".stale."));
      expect(setAside).toHaveLength(1);
      expect(await readFile(join(runDirectory, setAside[0] as string), "utf8")).toBe(
        live,
      );
    },
  );
});

describe("a set-aside lock that cannot be read back", () => {
  /**
   * The read of the set-aside file sat outside any `try`, and `readLock` rethrows everything that is
   * not ENOENT. So an EIO on a failing disk propagated out of `acquireRunLock` with the lock path
   * *empty* — the run name free, nothing restored, and an errno that did not even name the file now
   * holding what may be a live lock. Review found it in the span the previous round had just
   * narrowed. The file goes back first; the read failure is still what gets reported.
   */
  it("puts the lock back before reporting the failure", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-aside-read-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    const path = runLockPath(repositoryPath, triage);
    await mkdir(dirname(path), { recursive: true });
    const stale = lockBytes(DEAD);
    await writeFile(path, stale, "utf8");

    failAsideRead = { code: "EIO" };

    await expect(
      acquireRunLock(new DisposalStack(), {
        repositoryPath,
        runName: triage,
        probe: {
          self: () => Promise.resolve(OPERATOR),
          identify: () => Promise.resolve({ kind: "not-found" as const }),
        },
      }),
    ).rejects.toThrow(/EIO/);

    // Back where it was, byte for byte, and nothing left beside it.
    expect(await readFile(path, "utf8")).toBe(stale);
    expect((await readdir(dirname(path))).sort()).toEqual(["lock"]);
  });
});

/**
 * Mirrors `MAX_ATTEMPTS` in the source, which is not exported: nothing outside that module has any
 * business branching on it, and these two tests need the boundary rather than the value — a run of
 * refusals that ends and one that does not.
 */
const MAX_ATTEMPTS = 3;

describe("a run name that keeps coming free between the create and the read", () => {
  /**
   * The other way the last attempt can leave the name takeable, and the one that had no test: a
   * holder that releases while this run is looking. The rescue create after the loop was gated on
   * `reclaimed`, so this route still fell out of the loop and threw with the name free and nothing
   * holding it — the exact defect the gate was written for, on the half of it that had no coverage.
   * Ungated now, and it is one create with no judgement in it either way.
   */
  it("is taken by the create after the last attempt, not reported as contention", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-freed-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    // Every attempt's create is refused as though something were there, and every read then finds
    // nothing — so no attempt reaches a verdict and no reclamation happens.
    failLinkTimes = { code: "EEXIST", remaining: MAX_ATTEMPTS };

    const outcome = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: triage,
      probe: {
        self: () => Promise.resolve(OPERATOR),
        identify: () => Promise.resolve({ kind: "not-found" as const }),
      },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.reclaimed).toBeUndefined();
    expect(await readFile(runLockPath(repositoryPath, triage), "utf8")).toContain(
      `"pid": ${OPERATOR.pid}`,
    );
  });

  /**
   * And when it never comes free, the message says which of the two routes was taken. It used to say
   * the file "kept changing between the moment awcli looked at it and the moment it acted", which
   * describes both routes and fits neither: a live holder repeatedly winning the race was reported
   * as a churning file, sending the operator to look for something outside awcli.
   */
  it("says the lock kept going rather than blaming something outside awcli", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-exhausted-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    failLinkTimes = { code: "EEXIST", remaining: MAX_ATTEMPTS + 1 };

    const failure = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: triage,
      probe: {
        self: () => Promise.resolve(OPERATOR),
        identify: () => Promise.resolve({ kind: "not-found" as const }),
      },
    }).catch((error: unknown) => error);

    expect(String(failure)).toContain("was gone again by the time awcli read it");
    expect(String(failure)).toContain("no run was started and no lock was taken");
    expect(String(failure)).toContain(runLockPath(repositoryPath, triage));
    // The count covers the creates, not only the rounds: there is one more after the loop, and
    // "after 3 attempts" was read as a claim about how many times awcli had tried.
    expect(String(failure)).toContain(
      `on ${MAX_ATTEMPTS} attempts and once more after them`,
    );
  });
});

describe("a set-aside lock that has gone by the time it is read", () => {
  /**
   * Another process tidying up, or a filesystem that lost it. The judged lock is off the lock path
   * either way, which is what the reclamation had to achieve — so this counts as a removal, and
   * reporting it as a loss would drop the reclamation BR-035 requires be reported.
   */
  it("still counts as the reclamation it was, so the run reports it", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-aside-gone-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    const path = runLockPath(repositoryPath, triage);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, lockBytes(DEAD), "utf8");

    failAsideRead = { code: "ENOENT" };

    const stack = new DisposalStack();
    const outcome = await acquireRunLock(stack, {
      repositoryPath,
      runName: triage,
      probe: {
        self: () => Promise.resolve(OPERATOR),
        identify: () => Promise.resolve({ kind: "not-found" as const }),
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reclaimed?.reason).toBe("owner-gone");
    expect(outcome.reclaimed?.previousOwner).toEqual(DEAD);
    expect(await readFile(path, "utf8")).toContain(`"pid": ${OPERATOR.pid}`);
    await stack.unwind();
  });
});

describe("a reclamation that goes on to be refused", () => {
  /**
   * The loser of the ordinary post-reboot race. It reclaims the stale lock both runs found, and
   * another process links its own lock into the two syscalls between that removal and this one's
   * create. BR-035 has no exception for a reclamation followed by a refusal — the file is gone
   * either way — and the first version of this unit had no channel to report one on the refusal at
   * all.
   *
   * Staged here rather than in the main suite, where it used to live: that version parked a fake
   * probe between the removal and the create, and there is no longer a probe crossing there —
   * closing that gap is what stops the reclaiming attempt from sleeping with the run name free. The
   * filesystem is the only remaining seam, which is what this file is for.
   */
  it("still reports the reclamation it made on the way to being refused", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-reclaim-refused-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    const path = runLockPath(repositoryPath, triage);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, lockBytes(DEAD), "utf8");

    // A live lock appears at the path in the gap between the removal and the create.
    plantOnAsideUnlink = [lockBytes(RUNNING)];

    const stack = new DisposalStack();
    const outcome = await acquireRunLock(stack, {
      repositoryPath,
      runName: triage,
      probe: {
        self: () => Promise.resolve(OPERATOR),
        identify: (pid) =>
          Promise.resolve(
            pid === RUNNING.pid
              ? ({ kind: "running", identity: RUNNING } as const)
              : ({ kind: "not-found" } as const),
          ),
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Refused by the winner's lock, which is correct — and the stale lock this run destroyed on the
    // way is still reported, with the claim that follows it narrowed to what is true.
    expect(outcome.kind).toBe("held");
    expect(outcome.reclaimed?.reason).toBe("owner-gone");
    expect(outcome.reclaimed?.previousOwner).toEqual(DEAD);
    expect(outcome.message).toContain("Reclaimed a stale lock");
    expect(outcome.message).toContain("Apart from that, no run was started");
    // The winner is still holding it: this run took nothing and registered nothing.
    expect(await readFile(path, "utf8")).toBe(lockBytes(RUNNING));
    expect(stack.held).toEqual([]);
    expect(stack.leaks()).toEqual([]);
  });
});

describe("an acquisition that reclaims twice", () => {
  /**
   * Reachable, and the message has to survive it: reclaim, lose the name to something that takes it
   * in the gap, judge *that* file, find it stale too, reclaim it as well. Two files destroyed. The
   * reported reclamation was the last one, followed by a claim about everything else — which is the
   * "nothing else has been changed" defect one layer in, on a message that had already been fixed
   * twice for the same reason at the same spot.
   */
  it("lists every stale lock it destroyed, not only the last", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-twice-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    const path = runLockPath(repositoryPath, triage);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, lockBytes(DEAD), "utf8");

    // A second stale lock takes the name in the first gap; a live one takes it in the second, so the
    // run ends refused and a message is produced.
    plantOnAsideUnlink = [lockBytes(DEAD_AGAIN), lockBytes(RUNNING)];

    const outcome = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: triage,
      probe: {
        self: () => Promise.resolve(OPERATOR),
        identify: (pid) =>
          Promise.resolve(
            pid === RUNNING.pid
              ? ({ kind: "running", identity: RUNNING } as const)
              : ({ kind: "not-found" } as const),
          ),
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The field carries the most recent, which is what a caller can act on...
    expect(outcome.reclaimed?.previousOwner).toEqual(DEAD_AGAIN);
    // ...and the message accounts for both, before it says anything about everything else.
    expect(outcome.message.match(/Reclaimed a stale lock/g)).toHaveLength(2);
    expect(outcome.message).toContain(`process ${DEAD.pid}`);
    expect(outcome.message).toContain(`process ${DEAD_AGAIN.pid}`);
    expect(outcome.message).toContain("Apart from that, no run was started");
  });
});

describe("a failure that follows a reclamation", () => {
  /**
   * The stale lock is already destroyed by the time this throws, and the throw was the one exit that
   * never carried the note saying so: the operator got a bare ENOSPC with no indication that a file
   * had gone. BR-035's "never silent" has no exception for a run that went on to fail — review's
   * class as the refusal channel that had to be added for the same reason.
   */
  it("reports the reclamation as well as the failure", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-reclaim-fail-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    const path = runLockPath(repositoryPath, triage);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, lockBytes(DEAD), "utf8");

    // The first attempt reclaims the stale lock; the write on the attempt after it fails.
    failNextWrite = { code: "ENOSPC", after: 1 };

    const failure = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: triage,
      probe: {
        self: () => Promise.resolve(OPERATOR),
        identify: () => Promise.resolve({ kind: "not-found" as const }),
      },
    }).catch((error: unknown) => error);

    expect(String(failure)).toContain("ENOSPC");
    expect(String(failure)).toContain("Reclaimed a stale lock");
    expect(String(failure)).toContain("Apart from that, no run was started");
    // And the original failure is still reachable rather than replaced by the note.
    expect((failure as { cause?: { code?: string } }).cause?.code).toBe("ENOSPC");
  });
});

describe("a filesystem that will not hard-link", () => {
  it.each([
    { code: "ENOTSUP", expected: /does not support hard links/ },
    { code: "EOPNOTSUPP", expected: /does not support hard links/ },
    { code: "EMLINK", expected: /refused to add another link in that directory/ },
  ])("explains $code rather than passing the errno on", async ({ code, expected }) => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-link-"));
    repositories.push(repositoryPath);
    failEveryLink = { code };

    await expect(
      acquireRunLock(new DisposalStack(), {
        repositoryPath,
        runName: runName("triage"),
        probe: {
          self: () => Promise.resolve(OPERATOR),
          identify: () => Promise.resolve({ kind: "not-found" as const }),
        },
      }),
    ).rejects.toThrow(expected);
  });
});

describe("tidying up after a lock has been taken", () => {
  /**
   * By the time the staging file is removed the lock is already linked into place, so a failure
   * here must not become the outcome: throwing out of a *successful* acquisition leaves a lock on
   * disk that nothing will ever release, and the run name is unusable until someone deletes the
   * file by hand. A leftover `.staging.<uuid>` is inert by comparison.
   */
  it("does not turn a lock it took into a failure when the staging file will not go", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-tidy-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    failStagingUnlink = { code: "EIO" };

    const outcome = await acquireRunLock(new DisposalStack(), {
      repositoryPath,
      runName: triage,
      probe: {
        self: () => Promise.resolve(OPERATOR),
        identify: () => Promise.resolve({ kind: "not-found" as const }),
      },
    });

    expect(outcome.ok).toBe(true);
    expect(await readFile(runLockPath(repositoryPath, triage), "utf8")).toContain(
      `"pid": ${OPERATOR.pid}`,
    );
  });
});
