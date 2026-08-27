import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Acquisition, DisposalStack } from "./disposal.js";
import {
  livenessOf,
  systemProcessProbe,
  type Liveness,
  type ProcessIdentity,
  type ProcessProbe,
} from "./process-probe.js";
import { runDirectoryAncestors, runLockPath, type RunName } from "./run-identity.js";

/**
 * The exclusive lock a named run holds while it is in progress.
 *
 * Two runs of one name would write one state file, one record and one set of worktrees, and
 * interleaving those corrupts all three silently (BR-010). The lock makes that impossible. What
 * makes it usable is the other half: a lock is reclaimable when its owner is provably gone
 * (BR-035), because a machine that reboots mid-run must not leave a run name permanently unusable
 * — for a scheduled run, nobody would notice for days.
 *
 * "Provably gone" is doing real work in that sentence, in two directions.
 *
 * It rules out deciding from the lock's age. Nothing here reads `acquiredAt` to judge staleness: a
 * run that has been working for three hours is still a running run, and a timeout would evict it
 * and put two writers on one state file. (`acquiredAt` *is* read once, in `releaseRunLock`, as part
 * of telling one of this process's locks from another — an identity question, not a staleness one.)
 *
 * It also rules out treating an unanswered question as a dead process. Every path that cannot
 * establish where the owner is — the probe could not run, the lock was written by another machine
 * — refuses rather than reclaiming. A refusal costs the operator a retry. A wrong reclamation costs
 * them the corruption the lock exists to prevent, so the two are not symmetric and this file never
 * treats them as if they were.
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
 * `ProcessIdentity`.
 */
export interface RunLockContents {
  readonly run: string;
  readonly owner: ProcessIdentity;
  /** When this process took the lock. Reported, and part of identity; never a staleness test. */
  readonly acquiredAt: number;
  /**
   * Which machine took it.
   *
   * Read, not merely recorded. A pid means nothing outside the machine that issued it, so a lock
   * carrying another host's name cannot be judged from this machine's process table at all — and
   * the review of the first version of this file caught it doing exactly that, reclaiming a
   * synced-checkout lock and telling the operator its owner "was killed", which was false.
   */
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
  readonly run: RunName;
  readonly path: string;
  readonly contents: RunLockContents;
}

/** Why the lock could not be taken. */
export type RefusalKind =
  /** Someone else holds it and is demonstrably alive. */
  | "held"
  /**
   * Where the owner is could not be established: the probe could not answer, or the lock belongs
   * to another machine. Distinct from `held` because the remedy differs — this one may clear on
   * its own, and the operator is the only one who can say whether that host's run is still going.
   */
  | "undecidable";

export interface RunLockRefusal {
  readonly ok: false;
  readonly kind: RefusalKind;
  readonly run: RunName;
  /** The run this one collided with. */
  readonly holder: RunLockContents;
  readonly message: string;
  /**
   * A stale lock destroyed before the refusal happened.
   *
   * Reclamation is reported on this path too. It is reachable — reclaim a stale lock, lose the
   * race to link over it, meet the winner's live lock — and BR-035 says a reclamation is never
   * silent, without an exception for the case where the run went on to be refused anyway. The
   * first version of this file had no channel for it here at all.
   */
  readonly reclaimed?: Reclamation | undefined;
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
  /** Branded, so an unvalidated name cannot reach a path. See `RunName`. */
  readonly runName: RunName;
  /** Substituted in tests; the real one asks the operating system. */
  readonly probe?: ProcessProbe;
}

/**
 * How many times acquisition may go round.
 *
 * Two runs can find the same stale lock at the same moment; one wins the reclamation and the other
 * comes back to find a fresh, live lock and is refused, which is correct. The bound is what stops
 * that from being an unbounded spin — and the bound has to cover *every* way round the loop, not
 * just the interesting one. The first version of this file jumped the check with a `continue` when
 * it found the lock gone between the failed create and the read, which a dangling symlink at the
 * lock path pins for ever: `link` answers EEXIST because the link exists, `readFile` answers ENOENT
 * because its target does not, and awcli spins at startup burning a core. (The symlink itself is
 * now refused outright, but the bound is what makes the loop safe regardless of which future
 * filesystem oddity produces the same pair of answers.)
 */
const MAX_ATTEMPTS = 3;

/** Between attempts. Enough for a racing reclaimer to finish linking, so the retry sees a verdict. */
const RETRY_BACKOFF_MS = 25;

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
 * gate). Anything else — an unwritable directory, a full disk, a symlink where the lock should be
 * — is a genuine failure and is thrown.
 */
export async function acquireRunLock(
  stack: DisposalStack,
  request: RunLockRequest,
): Promise<RunLockOutcome> {
  const probe = request.probe ?? systemProcessProbe;
  const path = runLockPath(request.repositoryPath, request.runName);

  // Held outside the acquisition so a refusal or a reclamation survives it: `open` either returns
  // a handle or throws, and there is no third channel through the stack.
  let refusal: RunLockRefusal | undefined;
  let reclaimed: Reclamation | undefined;

  const refuse = (kind: RefusalKind, holder: RunLockContents, message: string): never => {
    refusal = { ok: false, kind, run: request.runName, holder, message, reclaimed };
    throw new RunLockHeldError(refusal);
  };

  const acquisition: Acquisition<RunLockHandle> = {
    name: RUN_LOCK_RESOURCE,
    // Always released. A worktree is preserved so an interrupted run's work survives; a lock
    // preserved is a run name nobody can use again (BR-021).
    disposition: "destroy",
    open: async () => {
      // Before the mkdir, and then again after it. `mkdir` with `recursive` *follows* an existing
      // symlink at any level, so a repository carrying a committed symlink at `.awcli` or
      // `.awcli/run` would have its run directory and its lock created outside the repository
      // entirely — and the old check, which looked only at the run directory, saw a real directory
      // there and passed. Reported by review; reproduced before fixing.
      await refuseSymlinkedAncestors(request.repositoryPath, request.runName);
      await mkdir(dirname(path), { recursive: true });
      await refuseSymlinkedAncestors(request.repositoryPath, request.runName);

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) await pause(RETRY_BACKOFF_MS);

        // Before anything writes or moves. A symlink at the lock path redirects both the write
        // and the removal outside the runtime root, and a dangling one answers EEXIST to `link`
        // and ENOENT to `readFile` at the same time — the pair that used to spin here for ever.
        await refuseSymlink(path, "lock");

        const contents = await freshContents(request, probe);

        if (await writeIfAbsent(path, contents)) {
          return { run: request.runName, path, contents };
        }

        const existing = await readLock(path);
        // Gone between the failed create and the read: whoever held it has released it. Round
        // again — under the attempt bound, which is the point.
        if (existing.kind === "absent") continue;

        // A lock nobody can parse is reclaimable, because `writeIfAbsent` links a complete file
        // into place: no awcli run can have left this behind. Note the limit of that reasoning,
        // which an earlier comment here overstated as "a live run cannot have left this" — it is a
        // statement about awcli's writer, not about the file. Something else that rewrites files
        // in the repository, a sync client mid-transfer being the realistic one, can truncate a
        // *live* run's lock, and then this reclaims it and two runs share the name. There is
        // nothing left in a truncated file to tell that case apart from an interrupted write, so
        // no check here can separate them, and refusing instead would turn any garbage at this
        // path into a manual intervention — which is the opposite of what BR-035 asks for. The
        // message says what is actually known rather than implying more.
        //
        // Everything else is decided by asking after the owner — never by the lock's age, which is
        // why a three-hour run keeps its lock.
        const liveness: Liveness =
          existing.kind !== "lock"
            ? "gone"
            : existing.contents.host !== contents.host
              ? // Another machine's pid is not a question this machine's process table can
                // answer. Refusing is the only honest move.
                "undecidable"
              : await livenessOf(existing.contents.owner, probe);

        if (existing.kind === "lock" && liveness === "live") {
          refuse(
            "held",
            existing.contents,
            heldMessage(request.runName, existing.contents, reclaimed),
          );
        }
        if (existing.kind === "lock" && liveness === "undecidable") {
          refuse(
            "undecidable",
            existing.contents,
            undecidableMessage(
              request.runName,
              existing.contents,
              contents.host,
              reclaimed,
            ),
          );
        }

        const reason = staleReasonFrom(existing, liveness);

        // The judged file's own bytes are what the removal verifies against.
        const removal = await removeExactly(path, { read: existing, reason }, probe);
        if (removal.kind === "removed") {
          reclaimed = {
            reason: removal.reason,
            previousOwner: removal.previousOwner,
            message: reclaimedMessage(
              request.runName,
              removal.reason,
              removal.previousOwner,
            ),
          };
        } else if (removal.kind === "disturbed") {
          // The file at the path changed between the judgement and the removal, the removal was
          // undone, and this attempt has no verdict. Round again rather than guess.
          continue;
        }
      }

      // A reclamation on the final round leaves the path free, and the loop as first written fell
      // straight out of it: the stale lock was deleted, no lock was taken, and the operator was
      // told the name was being fought over by other processes when in fact nothing held it. One
      // more create — bounded, no further judgement — is all that state needs.
      if (reclaimed !== undefined) {
        await refuseSymlink(path, "lock");
        const contents = await freshContents(request, probe);
        if (await writeIfAbsent(path, contents)) {
          return { run: request.runName, path, contents };
        }
      }

      throw new Error(
        `Could not take the lock for the "${request.runName}" run after ${MAX_ATTEMPTS} attempts: it is being taken and released repeatedly by other processes. ${changeNote(reclaimed)} Try again.`,
      );
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
 * A lock this process held can have been reclaimed from underneath it — a suspend long enough for
 * the probe to disagree does it, and so does a reclaimer that lost the identity check below and
 * put the file back. Unlinking blindly at that point would delete a *live* run's lock and let a
 * third run start alongside it, which is the exact corruption the lock prevents.
 *
 * The check narrows the window rather than closing it: the file is identified and then unlinked,
 * and nothing stops it changing in between. Closing that would need an atomic
 * compare-and-unlink, which POSIX does not offer portably. What it does guarantee is that a lock
 * *already* taken over before the release began is left alone, which is the case that actually
 * happens.
 */
async function releaseRunLock(held: RunLockHandle): Promise<void> {
  const current = await readLock(held.path);
  if (current.kind === "absent") return;
  if (
    current.kind !== "lock" ||
    current.contents.owner.pid !== held.contents.owner.pid ||
    current.contents.owner.startedAt !== held.contents.owner.startedAt ||
    current.contents.acquiredAt !== held.contents.acquiredAt
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
 * run can never leave one half-written. And creation must be atomic against another process doing
 * the same thing, or two runs racing for a free name could both believe they won.
 *
 * `link` gives both. The contents are written to a staging file first, so what is linked into
 * place is already whole; and a hard link fails with EEXIST when the destination exists, which
 * `rename` does not — rename would silently overwrite a live run's lock, the one thing this must
 * never do.
 *
 * The staging name is a UUID, not the pid and a millisecond. Two acquisitions from one process in
 * the same millisecond would otherwise share a staging path, and because the staging file is
 * hard-linked rather than copied, the second `writeFile` would truncate an *already linked* live
 * lock through the shared inode. `wx` on the staging file itself turns any residual collision into
 * an error instead of a corruption, and stops the write following a symlink planted at that name.
 */
async function writeIfAbsent(path: string, contents: RunLockContents): Promise<boolean> {
  const staging = `${path}.staging.${randomUUID()}`;
  try {
    await writeFile(staging, `${JSON.stringify(contents, undefined, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    // `wx` creates the file and then writes to it, so a failure part-way through — ENOSPC, EIO —
    // leaves an empty or half-written staging file behind with nobody to remove it. It would never
    // be linked into place and never be read, but it would accumulate in the run's directory and be
    // one more thing to explain to whoever is trying to work out why a lock is misbehaving.
    //
    // EEXIST is the one failure where the file must be left alone: it means something already
    // holds that name, so it is not ours to delete. A UUID makes that essentially unreachable,
    // which is the point of handling it rather than assuming it away.
    if (!isErrno(error, "EEXIST")) await unlink(staging).catch(ignoreMissing);
    throw error;
  }

  try {
    await link(staging, path);
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    // A filesystem without hard links — some network and fuse mounts — cannot give the atomic
    // create this depends on. Say so, rather than letting an errno reach the operator: the
    // remedy is to put the repository somewhere else, and no message derived from EPERM says that.
    // ENOTSUP and EOPNOTSUPP are the same answer as ENOSYS from a different filesystem — added
    // after review pointed out the list was short of the codes fuse and SMB mounts actually
    // return, which would have reached the operator as a bare errno on exactly the mounts this
    // message was written for.
    if (
      isErrno(error, "EPERM") ||
      isErrno(error, "ENOSYS") ||
      isErrno(error, "ENOTSUP") ||
      isErrno(error, "EOPNOTSUPP") ||
      isErrno(error, "EXDEV")
    ) {
      throw new Error(
        `awcli cannot create a run lock at ${path}: this filesystem does not support hard links, which is how the lock is made exclusive. Run against a repository on a local filesystem.`,
      );
    }
    // A different remedy, so a different message: the link count is exhausted rather than the
    // operation unsupported, and telling someone to move the repository would not help.
    if (isErrno(error, "EMLINK")) {
      throw new Error(
        `awcli cannot create a run lock at ${path}: the filesystem reports too many links here. Clear out leftover .staging or .stale files in that directory and run again.`,
      );
    }
    throw error;
  } finally {
    // Best effort, and deliberately not `ignoreMissing`. On the success path the lock is already
    // linked into place, so a failing unlink here — EIO, a read-only remount — would throw *out of
    // a successful acquisition*, leaving a lock on disk that nothing will ever release: the run
    // name would be unusable until someone deleted the file by hand. A leftover
    // `.staging.<uuid>` is inert by comparison. On the failure paths an exception from a `finally`
    // would replace the real error, which is worse than the litter either way.
    await unlink(staging).catch(ignoreCleanupFailure);
  }
}

/**
 * Refuses a symlink where awcli expects a real file or directory.
 *
 * The whole path down to the lock is attack-shaped: a repository can carry a committed symlink at
 * `.awcli`, at `.awcli/run`, at the run directory, or at the lock itself. What that buys an attacker
 * differs between the two cases, and an earlier version of this comment ran them together — review
 * was right that it did. A symlink at a *directory* level is followed by `mkdir` with `recursive`,
 * so the run directory and the lock are created wherever it points, outside the repository. A
 * symlink at the *lock path* is not followed by `link`, `rename` or `unlink`, which operate on the
 * link itself — but it is followed by `readFile`, so an unrelated file elsewhere on disk gets read
 * as this run's lock, and a dangling one answers EEXIST to `link` and ENOENT to `readFile` at the
 * same time, which is the pair the acquisition loop used to spin on for ever.
 */
async function refuseSymlink(path: string, what: string): Promise<void> {
  // Annotated: an unannotated `let` assigned inside a `try` is an implicit `any`, which would hide
  // a mistake in the Stats API rather than failing the typecheck. Flagged by review.
  const stats: Stats | undefined = await lstatOrMissing(path);
  if (stats === undefined) return;
  if (stats.isSymbolicLink()) {
    throw new Error(
      `${path} is a symbolic link, and awcli will not use one as a run ${what}: it would put the run's lock outside ${RUNTIME_ROOT_HINT}. Remove it and run again.`,
    );
  }
}

/**
 * Refuses a symlink anywhere between the repository root and the run directory.
 *
 * Outside in, stopping at the first component that does not exist: nothing can be below a path that
 * is not there, and `mkdir` will create the rest as real directories.
 *
 * The list comes from `runDirectoryAncestors`, which derives it forwards from the layout rather
 * than walking back up from the lock. Walking up needs a stopping condition, and comparing against
 * the repository path as a string got it wrong for `--repo /repo/` — see that function. Only the
 * repository's own `.awcli` and below are awcli's to inspect; how the operator spelled the path to
 * the repository, and what lies above it, are not.
 */
async function refuseSymlinkedAncestors(
  repositoryPath: string,
  runName: RunName,
): Promise<void> {
  for (const ancestor of runDirectoryAncestors(repositoryPath, runName)) {
    const stats = await lstatOrMissing(ancestor);
    if (stats === undefined) return;
    if (stats.isSymbolicLink()) {
      throw new Error(
        `${ancestor} is a symbolic link, and awcli will not follow one to reach a run's lock: the lock, and its removal, would land outside the repository. Remove it and run again.`,
      );
    }
  }
}

async function lstatOrMissing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

const RUNTIME_ROOT_HINT = "the repository's .awcli/run directory";

/**
 * What a verified removal did.
 *
 * `removed` carries the verdict on the file it *actually* removed rather than reusing the caller's.
 * On the mismatch path those differ — the caller judged one lock and the removal may legitimately
 * have taken away a second, also-stale one — and reporting the first would tell the operator a
 * reclamation happened for a reason that was true of a file still on disk.
 */
type Removal =
  | {
      readonly kind: "removed";
      readonly reason: StaleReason;
      readonly previousOwner: ProcessIdentity | undefined;
    }
  /** Another process removed or replaced it first; nothing was destroyed here. */
  | { readonly kind: "lost" }
  /** Something else was at the path; it was put back, and this attempt has no verdict. */
  | { readonly kind: "disturbed" };

/** The verdict a stale lock gets, from how it read and what its owner turned out to be. */
function staleReasonFrom(read: LockRead, liveness: Liveness): StaleReason {
  if (read.kind !== "lock") return "unreadable";
  return liveness === "different" ? "owner-replaced" : "owner-gone";
}

/**
 * Removes the lock file, but only if it is still the file that was judged stale.
 *
 * This is the correction to the first version of this file, and the bug it fixes is the one that
 * matters most here. That version renamed whatever was at the path aside, on the strength of a
 * judgement made before the rename — with a `ps` spawn in between, milliseconds wide. Two runs
 * meeting the same stale lock after a reboot, which is the ordinary case reclamation exists for,
 * could therefore both end up holding the name: the first reclaimed and linked its own lock, the
 * second then renamed *that live lock* aside and linked its own over the gap. Both believed they
 * held it. That is precisely the BR-010 corruption the lock exists to prevent, reached by the
 * normal path rather than by an exotic one, and the comment above it claimed rename-aside was
 * mutual exclusion. It is not. It is atomic *removal*; the exclusion has to come from checking
 * what was removed.
 *
 * So: take custody by renaming, then check that what was taken is what was judged. A mismatch
 * means the file was replaced in the window, and the replacement is re-judged rather than assumed —
 * if it is live, it goes back and this attempt reports no verdict.
 *
 * **Identity is the file's contents, not its inode.** The first attempt at this fix compared inode
 * numbers, and CI caught it on ext4: reclaiming the stale lock frees its inode, the very next
 * staging file is handed the same number, and so the winner's *live* lock compared equal to the
 * dead one and was deleted. That is the same bug one layer down — inode numbers are recycled,
 * exactly like the process ids this whole unit exists to stop trusting. macOS did not reproduce it,
 * which is what the Linux CI leg was for. A lock's bytes carry its pid, start time, host and
 * acquisition instant, so two distinct acquisitions cannot collide the way two inode numbers can.
 *
 * The window between the rename and the restoring link is not small, and an earlier version of this
 * comment claimed it was — "two syscalls rather than a subprocess spawn", written before the
 * re-judgement below was added, which reads the set-aside file and may spawn `ps` inside exactly
 * that window. Review caught the comment still saying it. What the code actually guarantees is
 * narrower and worth stating plainly: if a third process links its own lock into the gap, this
 * throws rather than proceeding, and the displaced lock is left on disk under its set-aside name
 * rather than deleted. At that point the tree is in a state no run should build on, and saying so —
 * with the path of the file that was moved — is better than taking a lock over it.
 */
async function removeExactly(
  path: string,
  judged: { readonly read: LockRead; readonly reason: StaleReason },
  probe: ProcessProbe,
): Promise<Removal> {
  const aside = `${path}.stale.${randomUUID()}`;
  try {
    await rename(path, aside);
  } catch (error) {
    // Another process got there first, or it was released normally in the meantime. Either way
    // this process did not reclaim anything and must not say that it did.
    if (isErrno(error, "ENOENT")) return { kind: "lost" };
    throw error;
  }

  const judgedRaw = judged.read.kind === "absent" ? undefined : judged.read.raw;
  const taken = await readLock(aside);
  if (taken.kind !== "absent" && taken.raw === judgedRaw) {
    await unlink(aside).catch(ignoreMissing);
    return {
      kind: "removed",
      reason: judged.reason,
      previousOwner: judged.read.kind === "lock" ? judged.read.contents.owner : undefined,
    };
  }

  // Not the file that was judged. If what was taken is itself stale, removing it was legitimate
  // and the loop can carry on; anything else must go back.
  //
  // The two ways this judgement can be wrong are not symmetric, so it is deliberately the same
  // judgement the acquisition path makes and not a looser one. Review caught it being looser in
  // both directions at once: a lock from another host counted as *stale* here — so it was deleted,
  // while the acquisition path refuses to judge another machine's pid at all — and a recycled pid
  // counted as *live*, so a genuinely abandoned lock was restored and the attempt spun instead of
  // reclaiming it. Deleting a lock this machine cannot speak for is the dangerous half.
  const takenLiveness: Liveness =
    taken.kind !== "lock"
      ? "gone"
      : taken.contents.host !== hostname()
        ? "undecidable"
        : await livenessOf(taken.contents.owner, probe);
  // `different` is a recycled process id: the owner recorded in that lock is as gone as one whose
  // id nothing holds.
  const takenIsStale = takenLiveness === "gone" || takenLiveness === "different";

  if (takenIsStale) {
    await unlink(aside).catch(ignoreMissing);
    return {
      kind: "removed",
      reason: staleReasonFrom(taken, takenLiveness),
      previousOwner: taken.kind === "lock" ? taken.contents.owner : undefined,
    };
  }

  // Only on the success path. The first version put this in a `finally`, which runs on the throw
  // paths too — so a restore that failed for any reason at all ended with the live lock deleted
  // rather than merely displaced, and the next run took the name alongside a process still
  // working under it. That is the BR-010 double-writer this whole function exists to prevent,
  // reached through the error handling of the fix for it. Reported by review; the two throws below
  // now leave the displaced lock on disk under its set-aside name, where an operator can see it and
  // where nothing mistakes it for the lock for this run.
  try {
    await link(aside, path);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new Error(
        `The lock for a run at ${path} was replaced by another process while awcli was reclaiming it, and the live lock it displaced could not be put back — it is at ${aside}. A run may still be in progress under it: check before starting another, then remove that file.`,
      );
    }
    throw new Error(
      `awcli set the lock for a run at ${path} aside while reclaiming it and could not put it back (${errnoOf(error) ?? String(error)}). The displaced lock is at ${aside}. A run may still be in progress under it: check before starting another, then remove that file.`,
      { cause: error },
    );
  }
  await unlink(aside).catch(ignoreCleanupFailure);
  return { kind: "disturbed" };
}

/**
 * What was at the lock path: the exact bytes, and the parse of them if they parse.
 *
 * The raw text is carried because it *is* the lock's identity. See `removeExactly` for why nothing
 * here identifies a file by its inode.
 */
type LockRead =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly raw: string }
  | { readonly kind: "lock"; readonly raw: string; readonly contents: RunLockContents };

async function readLock(path: string): Promise<LockRead> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "absent" };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", raw };
  }
  return isLockContents(parsed)
    ? { kind: "lock", raw, contents: parsed }
    : { kind: "unreadable", raw };
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

/**
 * What a refusal says about what it did or did not change.
 *
 * A refusal that reclaimed a stale lock on the way *has* changed something, so it must not claim
 * otherwise — the first version printed "Nothing has been changed" unconditionally, including
 * after deleting a file.
 */
function changeNote(reclaimed: Reclamation | undefined): string {
  return reclaimed === undefined
    ? "Nothing has been changed."
    : `${reclaimed.message} Nothing else has been changed.`;
}

/**
 * The acquisition instant, as a string, for a value that came off disk.
 *
 * `new Date(x).toISOString()` throws RangeError for anything out of range, and `acquiredAt` is a
 * number a commit can contain. A refusal that throws while formatting itself would reach the
 * operator as a stack trace instead of as the explanation of why their run will not start.
 */
function acquiredAtText(holder: RunLockContents): string {
  const at = new Date(holder.acquiredAt);
  return Number.isFinite(at.getTime())
    ? at.toISOString()
    : `an unreadable time (${printable(String(holder.acquiredAt))})`;
}

function heldMessage(
  run: string,
  holder: RunLockContents,
  reclaimed: Reclamation | undefined,
): string {
  return `The "${run}" run is already in progress: process ${holder.owner.pid} on ${printable(holder.host)} has held its lock since ${acquiredAtText(holder)}. ${changeNote(reclaimed)} Wait for it to finish, or start this run under a different --name.`;
}

function undecidableMessage(
  run: string,
  holder: RunLockContents,
  thisHost: string,
  reclaimed: Reclamation | undefined,
): string {
  const where =
    holder.host === thisHost
      ? `whether process ${holder.owner.pid} is still running could not be established on this machine`
      : `its lock was taken on "${printable(holder.host)}", not on this machine ("${thisHost}"), so a process id in it means nothing here`;
  return `awcli will not take the lock for the "${run}" run: ${where}. ${changeNote(reclaimed)} If that run is finished, remove ${RUNTIME_ROOT_HINT}'s lock for it, or start this run under a different --name.`;
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
        : "the lock file could not be read as a lock, and awcli only ever puts a complete one there";
  return `Reclaimed a stale lock on the "${run}" run: ${why}.`;
}

/**
 * Waits between attempts, and keeps the event loop alive while it waits.
 *
 * The first version unref'd this timer, copying the pattern from `disposal.ts` — where it is
 * correct, because those timers are timeout races that must not by themselves hold a process open.
 * Here the delay is the thing the acquisition is waiting *on*, and an unref'd timer with nothing
 * else pending lets node decide the loop is empty and exit. Reproduced from a child process before
 * fixing: against a real stale lock, `acquireRunLock` reclaimed it and then never returned at all —
 * no lock, no refusal, no error, exit 13 on an unsettled await. That is the ordinary BR-035
 * reclaim path, and it hits every other route round the loop too.
 *
 * The suite cannot see this, because vitest holds the event loop open for it. Which is why the
 * gate for it runs node directly: `scripts/verify-acquisition-returns.sh`.
 */
function pause(ms: number): Promise<void> {
  return sleep(ms);
}

/** What this process would write into a lock right now. */
async function freshContents(
  request: RunLockRequest,
  probe: ProcessProbe,
): Promise<RunLockContents> {
  return {
    run: request.runName,
    owner: await probe.self(),
    acquiredAt: Date.now(),
    host: hostname(),
  };
}

function isErrno(error: unknown, code: string): boolean {
  return errnoOf(error) === code;
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function ignoreMissing(error: unknown): void {
  if (!isErrno(error, "ENOENT")) throw error;
}

/**
 * Swallows a failure to tidy up.
 *
 * Only for removing this process's own scratch files after the outcome is already decided. See
 * `writeIfAbsent` for why an error from that cannot be allowed to become the outcome.
 */
function ignoreCleanupFailure(): void {}

/**
 * A string from a lock file, safe to put in a message.
 *
 * The lock is a file in the repository, so its `host` and `run` arrive from disk and can be
 * anything a commit can contain. Printed straight to a terminal, an escape sequence in one of them
 * repaints the screen, and the operator can be shown a refusal that says something awcli never
 * said. Control characters go, and the length is capped: a hostname is not 4kB long, and a message
 * that scrolls the real explanation off the screen has failed at the only job it has.
 */
function printable(value: string): string {
  const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  return stripped.length > PRINTABLE_LIMIT
    ? `${stripped.slice(0, PRINTABLE_LIMIT)}...`
    : stripped;
}

const PRINTABLE_LIMIT = 64;
