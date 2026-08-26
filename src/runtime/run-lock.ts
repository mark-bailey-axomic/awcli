import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { Acquisition, DisposalStack } from "./disposal.js";
import {
  livenessOf,
  systemProcessProbe,
  type Liveness,
  type ProcessIdentity,
  type ProcessProbe,
} from "./process-probe.js";
import { runLockPath } from "./run-identity.js";

/**
 * The exclusive lock a named run holds while it is in progress.
 *
 * Two runs of one name would write one state file, one record and one set of worktrees, and
 * interleaving those corrupts all three silently (BR-010). The lock makes that impossible. What
 * makes it usable is the other half: a lock is reclaimable when its owner is provably gone
 * (BR-035), because a machine that reboots mid-run must not leave a run name permanently unusable
 * — for a scheduled run, nobody would notice for days.
 *
 * "Provably gone" is doing real work in that sentence. The lock records *who* holds it, not just
 * when it was taken, so the decision is about the owner's existence rather than about a timeout on
 * the file's age. A run that has been working for three hours is still a running run; a timeout
 * would evict it, and the operator would find two runs writing one state file. That is the reason
 * this file never looks at the lock's age.
 *
 * It is not a security boundary (see the TDD's security notes). It stops one operator's two runs
 * from colliding by accident. It does not stop a determined process from deleting the file.
 */

/** The resource name the disposal stack reports this under. Operator-facing. */
export const RUN_LOCK_RESOURCE = "run lock";

/**
 * What the lock file holds.
 *
 * Written as JSON rather than as a bare pid, because a pid alone cannot be checked: see
 * `ProcessIdentity`. `acquiredAt` is recorded for the record and for messages only — no decision
 * in this file reads it, deliberately.
 */
export interface RunLockContents {
  readonly run: string;
  readonly owner: ProcessIdentity;
  /** When this process took the lock. Reported, never used to decide staleness. */
  readonly acquiredAt: number;
  /** Which machine took it, so a lock found in a synced checkout can be explained. */
  readonly host: string;
}

/** Why a lock was reclaimable. */
export type StaleReason =
  /** No process holds the recorded id. */
  | "owner-gone"
  /** A process holds the recorded id, but it started at a different time — a recycled id. */
  | "owner-replaced"
  /** The file could not be read as a lock at all. */
  | "unreadable";

export interface Reclamation {
  readonly reason: StaleReason;
  /** The owner recorded in the reclaimed lock, when the file was readable enough to say. */
  readonly previousOwner?: ProcessIdentity | undefined;
  /** Operator-facing: what was reclaimed and why. Never omitted — reclamation is never silent. */
  readonly message: string;
}

export interface RunLockHandle {
  readonly run: string;
  readonly path: string;
  readonly contents: RunLockContents;
}

export interface RunLockRefusal {
  readonly ok: false;
  readonly run: string;
  /** The live run this one collided with. */
  readonly holder: RunLockContents;
  readonly message: string;
}

export type RunLockOutcome =
  | {
      readonly ok: true;
      readonly lock: RunLockHandle;
      /** Present exactly when a stale lock was taken over, so a caller cannot fail to notice. */
      readonly reclaimed?: Reclamation | undefined;
    }
  | RunLockRefusal;

export interface RunLockRequest {
  readonly repositoryPath: string;
  readonly runName: string;
  /** Substituted in tests; the real one asks the operating system. */
  readonly probe?: ProcessProbe;
}

/**
 * How many times acquisition may go round after reclaiming a stale lock.
 *
 * Two runs can find the same stale lock at the same moment; one wins the reclamation and the
 * other comes back to find a fresh, live lock and is refused, which is correct. The bound is what
 * stops that from being an unbounded spin if the pathological case repeats — and three is
 * generous, because each round requires another process to have both reclaimed and died.
 */
const MAX_ATTEMPTS = 3;

/**
 * Takes the lock for a run name, reclaiming it if its owner is gone, and registers its release.
 *
 * Acquisition goes through the disposal stack rather than returning a handle for the caller to
 * remember to release: BR-021 says the lock is always released, on every exit path including a
 * crash of the workflow body, and a call site that has to remember is a call site that will not
 * (ADR-0001's note on why disposal is a mechanism and not a convention).
 *
 * A collision comes back as a refusal rather than as a throw, because that is what the gate chain
 * consumes — a refusal names the thing to fix and nothing has happened yet (BR-010 is a startup
 * gate). Anything else — an unwritable directory, a full disk — is a genuine failure and is
 * thrown.
 */
export async function acquireRunLock(
  stack: DisposalStack,
  request: RunLockRequest,
): Promise<RunLockOutcome> {
  const probe = request.probe ?? systemProcessProbe;
  const path = runLockPath(request.repositoryPath, request.runName);

  // Held outside the acquisition so a refusal or a reclamation survives it: `open` either
  // returns a handle or throws, and there is no third channel through the stack.
  let refusal: RunLockRefusal | undefined;
  let reclaimed: Reclamation | undefined;

  const acquisition: Acquisition<RunLockHandle> = {
    name: RUN_LOCK_RESOURCE,
    // Always released. A worktree is preserved so an interrupted run's work survives; a lock
    // preserved is a run name nobody can use again (BR-021).
    disposition: "destroy",
    open: async () => {
      await mkdir(dirname(path), { recursive: true });

      for (let attempt = 1; ; attempt++) {
        const contents: RunLockContents = {
          run: request.runName,
          owner: probe.self(),
          acquiredAt: Date.now(),
          host: hostname(),
        };

        if (await writeIfAbsent(path, contents)) {
          return { run: request.runName, path, contents };
        }

        const existing = await readLock(path);
        // Gone between the failed create and the read: whoever held it has released it, so go
        // straight round again rather than reporting a reclamation that did not happen.
        if (existing === "absent") continue;

        // A lock nobody can parse is reclaimable, because `writeIfAbsent` links a complete file
        // into place: a live run cannot have left this. Anything else is decided by asking after
        // the owner — never by the lock's age, which is why a three-hour run keeps its lock.
        const liveness: Liveness =
          existing === "unreadable" ? "gone" : livenessOf(existing.owner, probe);
        const previousOwner = existing === "unreadable" ? undefined : existing.owner;

        if (liveness === "live" && existing !== "unreadable") {
          refusal = {
            ok: false,
            run: request.runName,
            holder: existing,
            message: heldMessage(request.runName, existing),
          };
          throw new RunLockHeldError(refusal);
        }

        const reason: StaleReason =
          existing === "unreadable"
            ? "unreadable"
            : liveness === "gone"
              ? "owner-gone"
              : "owner-replaced";

        // Renamed away rather than deleted in place, and that is the mutual exclusion: two runs
        // reclaiming the same stale lock rename to different names, so exactly one succeeds. The
        // loser sees ENOENT, goes round, and meets the winner's live lock — a refusal, correctly.
        if (await renameAway(path, probe)) {
          reclaimed = {
            reason,
            previousOwner,
            message: reclaimedMessage(request.runName, reason, previousOwner),
          };
        }

        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(
            `Could not take the lock for the "${request.runName}" run after ${MAX_ATTEMPTS} attempts: it is being reclaimed and abandoned repeatedly by other processes. Nothing has been changed; try again.`,
          );
        }
      }
    },
    release: async (held) => {
      await releaseRunLock(held);
    },
  };

  try {
    const lock = await stack.acquire(acquisition);
    return { ok: true, lock, reclaimed };
  } catch (error) {
    // The refusal is the interesting exit and the only one that is not a failure. Rethrowing
    // anything else keeps a real error — a read-only repository, a full disk — from being
    // reported as "another run holds this".
    if (error instanceof RunLockHeldError) return error.refusal;
    throw error;
  }
}

/** Thrown out of the acquisition so a live holder becomes a refusal rather than a held lock. */
class RunLockHeldError extends Error {
  constructor(readonly refusal: RunLockRefusal) {
    super(refusal.message);
    this.name = "RunLockHeldError";
  }
}

/**
 * Lets a lock go, but only if it is still the lock this process took.
 *
 * The check is not defensive padding. A lock this process held can have been reclaimed from
 * underneath it — that is what happens when the machine suspends long enough for the probe to
 * disagree, or when a stale-looking lock was taken over by another run. Unlinking blindly at that
 * point would delete a *live* run's lock and let a third run start alongside it, which is the
 * exact corruption the lock prevents. So the release identifies what it is about to remove.
 */
async function releaseRunLock(held: RunLockHandle): Promise<void> {
  const current = await readLock(held.path);
  if (current === "absent") return;
  if (
    current === "unreadable" ||
    current.owner.pid !== held.contents.owner.pid ||
    current.owner.startedAt !== held.contents.owner.startedAt ||
    current.acquiredAt !== held.contents.acquiredAt
  ) {
    // Someone else's lock now. Leaving it is the only safe move; the run that owns it will
    // release it, and if it will not, the next run reclaims it as stale.
    return;
  }
  await unlink(held.path).catch(ignoreMissing);
}

/**
 * Creates the lock file if and only if nothing is there, and answers whether it did.
 *
 * Two properties at once, and neither is optional here. The file must appear complete or not at
 * all — an unreadable lock is treated as reclaimable, and that reasoning is only sound if a live
 * run can never leave one half-written. And creation must be atomic against another process
 * doing the same thing, or two runs racing for a free name could both believe they won.
 *
 * `link` gives both. The contents are written to a staging file first, so what is linked into
 * place is already whole; and a hard link fails with EEXIST when the destination exists, which
 * `rename` does not — rename would silently overwrite a live run's lock, the one thing this must
 * never do.
 */
async function writeIfAbsent(path: string, contents: RunLockContents): Promise<boolean> {
  const staging = `${path}.staging.${contents.owner.pid}.${contents.acquiredAt}`;
  await writeFile(staging, `${JSON.stringify(contents, undefined, 2)}\n`, "utf8");
  try {
    await link(staging, path);
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  } finally {
    await unlink(staging).catch(ignoreMissing);
  }
}

/** Moves a stale lock out of the way. Answers whether this process was the one that moved it. */
async function renameAway(path: string, probe: ProcessProbe): Promise<boolean> {
  const aside = `${path}.stale.${probe.self().pid}`;
  try {
    await rename(path, aside);
  } catch (error) {
    // Another process got there first, or it was released normally in the meantime. Either way
    // this process did not reclaim anything and must not say that it did.
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  await unlink(aside).catch(ignoreMissing);
  return true;
}

/** The lock's contents, or why they could not be had. */
async function readLock(
  path: string,
): Promise<RunLockContents | "absent" | "unreadable"> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "absent";
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unreadable";
  }
  return isLockContents(parsed) ? parsed : "unreadable";
}

function isLockContents(value: unknown): value is RunLockContents {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RunLockContents>;
  const owner = candidate.owner;
  return (
    typeof candidate.run === "string" &&
    typeof candidate.acquiredAt === "number" &&
    typeof candidate.host === "string" &&
    typeof owner === "object" &&
    owner !== null &&
    typeof owner.pid === "number" &&
    typeof owner.startedAt === "number"
  );
}

function heldMessage(run: string, holder: RunLockContents): string {
  return `The "${run}" run is already in progress: process ${holder.owner.pid} on ${holder.host} has held its lock since ${new Date(holder.acquiredAt).toISOString()}. Nothing has been changed. Wait for it to finish, or start this run under a different --name.`;
}

function reclaimedMessage(
  run: string,
  reason: StaleReason,
  previousOwner: ProcessIdentity | undefined,
): string {
  const owner =
    previousOwner === undefined ? "its owner" : `process ${previousOwner.pid}`;
  const why =
    reason === "owner-gone"
      ? `${owner} is no longer running — the run it belonged to was killed or the machine restarted`
      : reason === "owner-replaced"
        ? `the process id it recorded now belongs to a different process, so ${owner} is gone`
        : "the lock file could not be read as a lock, and a live run never leaves it that way";
  return `Reclaimed a stale lock on the "${run}" run: ${why}.`;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

function ignoreMissing(error: unknown): void {
  if (!isErrno(error, "ENOENT")) throw error;
}
