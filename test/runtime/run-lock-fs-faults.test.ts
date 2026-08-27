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

/** Set by a test to make the next staging write create its file and then fail. */
let failNextWrite: { readonly code: string } | undefined;
/** Set by a test to fail the `link` that puts a displaced lock back. */
let failRestoringLink: { readonly code: string } | undefined;
/** Set by a test to fail every `link`, as a filesystem without hard links does. */
let failEveryLink: { readonly code: string } | undefined;
/** Set by a test to fail the tidy-up of a staging file whose lock is already linked into place. */
let failStagingUnlink: { readonly code: string } | undefined;

function faulted(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    writeFile: async (
      file: Parameters<typeof real.writeFile>[0],
      data: Parameters<typeof real.writeFile>[1],
      options?: Parameters<typeof real.writeFile>[2],
    ) => {
      const failure = failNextWrite;
      if (failure === undefined) return real.writeFile(file, data, options);
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
      // The restore is the only `link` whose source is a set-aside lock.
      if (failRestoringLink !== undefined && String(existing).includes(".stale.")) {
        const failure = failRestoringLink;
        failRestoringLink = undefined;
        throw faulted(failure.code);
      }
      return real.link(existing, next);
    },
    unlink: async (target: Parameters<typeof real.unlink>[0]) => {
      if (failStagingUnlink !== undefined && String(target).includes(".staging.")) {
        const failure = failStagingUnlink;
        failStagingUnlink = undefined;
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

const HERE = hostname();
const OPERATOR: ProcessIdentity = { pid: 4242, startedAt: 1_700_000_000_000 };
const RUNNING: ProcessIdentity = { pid: 4343, startedAt: 1_700_000_500_000 };
const DEAD: ProcessIdentity = { pid: 9500, startedAt: 1_600_000_000_000 };

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
  it("is left on disk rather than deleted, and the failure says where it is", async () => {
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
    failRestoringLink = { code: "ENOSPC" };
    parked.release();

    await expect(acquiring).rejects.toThrow(/could not put it back/);

    // The live lock's bytes are still on disk somewhere, under the set-aside name the message named.
    const entries = await readdir(runDirectory);
    const setAside = entries.filter((entry) => entry.includes(".stale."));
    expect(setAside).toHaveLength(1);
    expect(await readFile(join(runDirectory, setAside[0] as string), "utf8")).toBe(live);
  });
});

describe("a filesystem that will not hard-link", () => {
  it.each([
    { code: "ENOTSUP", expected: /does not support hard links/ },
    { code: "EOPNOTSUPP", expected: /does not support hard links/ },
    { code: "EMLINK", expected: /too many links/ },
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
