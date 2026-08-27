import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Acquisition, DisposalStack } from "./disposal.js";
import {
  livenessOf,
  systemProcessProbe,
  type Liveness,
  type LivenessVerdict,
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
   *
   * Required rather than optional, on both outcomes. BR-035 asks for a reclamation to be reported,
   * and an optional field is one every construction site may quietly leave out — review's point,
   * and the reason `undefined` is spelled out here instead. It does not make a caller print it, but
   * it does make every producer of an outcome say whether there was one.
   */
  readonly reclaimed: Reclamation | undefined;
}

export type RunLockOutcome =
  | {
      readonly ok: true;
      readonly lock: RunLockHandle;
      /** Set exactly when a stale lock was taken over. Never optional — see the refusal's copy. */
      readonly reclaimed: Reclamation | undefined;
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
 *
 * Three rather than two because a reclamation that finds the file replaced under it puts the file
 * back and spends the attempt without a verdict: the replacement is judged on the round after,
 * where the lock is on disk while it is being judged rather than set aside. See `removeExactly`.
 * A leftover from someone else's reclamation, which `displacedHolder` waits out rather than
 * refusing on, spends an attempt the same way. Two independent races in one startup would exhaust
 * the budget and throw, which is the correct end for a name nobody can get a clean look at.
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
      try {
        await mkdir(dirname(path), { recursive: true });
      } catch (error) {
        refuseUnwritable(error, dirname(path));
        throw error;
      }
      await refuseSymlinkedAncestors(request.repositoryPath, request.runName);

      const thisHost = hostname();
      // Why an attempt ended without a verdict, when one did. Read only by the message at the end:
      // "the file kept changing" is true of every route to it and points at the wrong culprit for
      // the common one, which is another awcli run winning the same race repeatedly.
      let inconclusive: Inconclusive | undefined;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) await pause(RETRY_BACKOFF_MS);

        // Before anything writes or moves, and before anything *reads* — the leftover scan below
        // reads this path too. `link`, `rename` and `unlink` operate on the link itself, so this is
        // not about the write or the removal landing elsewhere — that is the *directory* case, and
        // an earlier version of this comment ran the two together. It is about `readFile`, which
        // follows a symlink and would read an unrelated file as this run's lock; and about a
        // dangling one, which answers EEXIST to `link` and ENOENT to `readFile` at the same time —
        // the pair that used to spin here for ever. See `refuseSymlink`.
        await refuseSymlink(path, "lock");

        // Before the name is treated as free: a lock beside this one is either a run a previous
        // reclamation could not put back, or a reclamation another process is in the middle of, and
        // until this was here nothing ever read one again.
        //
        // Inside the loop, and a retry until the attempts run out, rather than a refusal on first
        // sight. The second case is the ordinary one and it clears in microseconds — that window is
        // a rename, a read and a link with nothing else in it — so refusing immediately sent the
        // operator to wait for a run that had already finished and to remove a file that had
        // already gone. Review's point. Only a leftover that is *still* there after every attempt
        // is treated as a run in progress.
        const displaced = await displacedHolder(path, thisHost, probe);
        if (displaced !== undefined) {
          // Not recorded in `inconclusive`: this route cannot reach the message that reads it,
          // because the last attempt refuses rather than continuing.
          if (attempt < MAX_ATTEMPTS) continue;
          refuse(
            displaced.verdict.liveness === "live" ? "held" : "undecidable",
            displaced.contents,
            displacedMessage(request.runName, displaced, thisHost, reclaimed),
          );
        }

        const contents = await freshContents(request, probe);

        if (await writeIfAbsent(path, contents)) {
          return { run: request.runName, path, contents };
        }

        const existing = await readLock(path);
        // Gone between the failed create and the read: whoever held it has released it. Round
        // again — under the attempt bound, which is the point.
        if (existing.kind === "absent") {
          inconclusive = "released";
          continue;
        }

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
        const verdict: LivenessVerdict =
          existing.kind !== "lock"
            ? { liveness: "gone", reason: undefined }
            : await judgeOwner(existing.contents, thisHost, probe);

        if (existing.kind === "lock" && verdict.liveness === "live") {
          refuse(
            "held",
            existing.contents,
            heldMessage(request.runName, path, existing.contents, reclaimed),
          );
        }
        if (existing.kind === "lock" && verdict.liveness === "undecidable") {
          refuse(
            "undecidable",
            existing.contents,
            undecidableMessage(
              request.runName,
              path,
              existing.contents,
              contents.host,
              verdict.reason,
              reclaimed,
            ),
          );
        }

        const reason = staleReasonFrom(existing, verdict.liveness);
        const previousOwner =
          existing.kind === "lock" ? existing.contents.owner : undefined;

        // The judged file's own bytes are what the removal verifies against.
        const removal = await removeExactly(path, existing);
        if (removal.kind === "removed") {
          reclaimed = {
            reason,
            previousOwner,
            message: reclaimedMessage(request.runName, reason, previousOwner),
          };
        } else if (removal.kind === "disturbed") {
          // The file at the path changed between the judgement and the removal, the removal was
          // undone, and this attempt has no verdict. Round again rather than guess.
          inconclusive = "replaced";
          continue;
        }
      }

      // The last round can leave the path free two ways, and the loop as first written fell straight
      // out of both: a reclamation that freed it, and a holder that released it while this run was
      // looking. The stale lock was deleted or the name was idle, no lock was taken, and the
      // operator was told the name was being fought over when nothing held it. One more create —
      // bounded, and with no judgement in it — is all either state needs.
      //
      // Not gated on a reclamation any more. It was, and that left the second route still throwing
      // with the name free: review's point, and the narrower fix was covering only the case that
      // had a test. `rescue` rather than reusing the name `contents` so that the gate can anchor on
      // this create and not on the one in the loop.
      await refuseSymlink(path, "lock");
      const rescue = await freshContents(request, probe);
      if (await writeIfAbsent(path, rescue)) {
        return { run: request.runName, path, contents: rescue };
      }

      // What it says is what was observed, and no more. It used to assert a single cause — "it is
      // being taken and released repeatedly by other processes" — and then, having been narrowed to
      // "the file kept changing", still described a *live holder repeatedly winning the race* as a
      // churning file and sent the operator looking for something outside awcli. Review's point
      // twice over. `inconclusive` carries what the last inconclusive attempt actually saw, so the
      // sentence names one of the two routes rather than a guess covering both.
      //
      // Thrown rather than returned as a refusal, which review also asked about. A refusal names the
      // run it collided with, and this path has no such run to name: every candidate was gone by the
      // time it was looked at. Widening the refusal to carry no holder would let every consumer of
      // one stop handling the field that makes a refusal actionable.
      const observed =
        inconclusive === "released"
          ? `the lock at ${path} was gone again by the time awcli read it, on every attempt`
          : inconclusive === "replaced"
            ? `another process replaced the lock at ${path} each time awcli set it aside to reclaim it`
            : `another process took the name in the moment after awcli freed it`;
      throw new Error(
        `Could not take the lock for the "${request.runName}" run after ${MAX_ATTEMPTS} attempts: ${observed}. ${changeNote(reclaimed)} Another awcli run contending for this name is the likeliest cause, and trying again is usually enough; if this name should be idle, find out what else is writing ${path}.`,
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
    // A throw that *follows* a reclamation still has to report it. BR-035's "never silent" has no
    // exception for a run that went on to fail: the stale lock is already destroyed, and this was
    // the one exit `changeNote` had never been applied to, so an ENOSPC on the next write reached
    // the operator with no indication that a file had gone. Review's point, and the same class as
    // the refusal channel two rounds earlier. The original error is the cause, so nothing about it
    // is lost.
    if (reclaimed !== undefined) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} ${changeNote(reclaimed)}`,
        { cause: error },
      );
    }
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
    refuseUnwritable(error, dirname(path));
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
    // EMLINK is its own message because the operation is refused for a different reason, but the
    // remedy it used to give — clear out leftover .staging and .stale files — could not work, which
    // review was right to flag. The link count that is exhausted belongs to the *source* inode, and
    // the source here is a staging file this process created a moment ago with one link on it, so
    // nothing in that directory is contributing to it. What is left to say is what was refused and
    // where to go instead.
    if (isErrno(error, "EMLINK")) {
      throw new Error(
        `awcli cannot create a run lock at ${path}: the filesystem refused to add a link to a file awcli had just created (EMLINK), which is not something clearing that directory will change. Run against a repository on a local filesystem.`,
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
      `${path} is a symbolic link, and awcli will not use one as a run ${what}: awcli would read whatever it points at as this run's lock, and a dangling one reports "exists" to the create and "missing" to the read at the same time. Remove it and run again.`,
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

/**
 * What a verified removal did.
 *
 * `removed` carries no verdict of its own, and that is this round's change. It used to: the file it
 * removed was not necessarily the file the caller judged, because a replacement found under the
 * set-aside name was re-judged here and removed if it too was stale. Reporting the caller's verdict
 * for a different file would have been a lie, so the verdict travelled back. The re-judgement is
 * gone — see `removeExactly` for why it cannot happen with the run name free — so the file removed
 * is always the file judged, and the caller already knows what it decided about it.
 */
type Removal =
  /** The judged file is off the lock path. */
  | { readonly kind: "removed" }
  /** Another process removed or replaced it first; nothing was destroyed here. */
  | { readonly kind: "lost" }
  /** Something else was at the path; it was put back, and this attempt has no verdict. */
  | { readonly kind: "disturbed" };

/**
 * Where a lock's owner is, as far as this machine can tell.
 *
 * One function, because two places ask — the lock path and a leftover beside it — and the ladder
 * they need is the same: another machine's pid is not a question this process table can answer, and
 * everything else goes to the probe. A second copy of this ladder was deleted a round ago for having
 * drifted from the first, and review caught the displaced-lock fix adding a third by hand the round
 * after. The same fix, one round apart, in both directions.
 */
async function judgeOwner(
  holder: RunLockContents,
  thisHost: string,
  probe: ProcessProbe,
): Promise<LivenessVerdict> {
  if (holder.host !== thisHost) {
    return { liveness: "undecidable", reason: undefined };
  }
  return livenessOf(holder.owner, probe);
}

/** Why an attempt ended with no verdict. Only ever read by the message after the last one. */
type Inconclusive =
  /** The lock was gone again by the time it was read. */
  | "released"
  /** Another process replaced it while it was set aside for removal. */
  | "replaced";

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
 * So: take custody by renaming, then check that what was taken is what was judged. A mismatch means
 * the file was replaced in the window, and the replacement goes straight back — unjudged, as the
 * paragraph below explains. Until review round 4 this sentence still said the replacement was
 * "re-judged rather than assumed", twenty-four lines above the text describing why it is not: the
 * one docblock the remediation for that defect had rewritten was left half-describing the code it
 * removed. Which is the failure class of this whole ticket, in a comment.
 *
 * **Identity is the file's contents, not its inode.** The first attempt at this fix compared inode
 * numbers, and CI caught it on ext4: reclaiming the stale lock frees its inode, the very next
 * staging file is handed the same number, and so the winner's *live* lock compared equal to the
 * dead one and was deleted. That is the same bug one layer down — inode numbers are recycled,
 * exactly like the process ids this whole unit exists to stop trusting. macOS did not reproduce it,
 * which is what the Linux CI leg was for. A lock's bytes carry its pid, start time, host and
 * acquisition instant, so two distinct acquisitions cannot collide the way two inode numbers can.
 *
 * **Nothing is judged while the run name is free.** The rename empties the lock path, and it stays
 * empty until the restoring link. Two rounds of review went into what may happen in that gap, and
 * the answer this version gives is: the identity comparison, and nothing else. The previous version
 * re-judged the replacement there — `livenessOf`, and on macOS a `ps` spawn bounded only by its
 * two-second timeout — and read the set-aside file with nothing catching a failure, so an `EIO`
 * propagated out of `acquireRunLock` with the name free and the displaced file unnamed. Any run
 * starting inside that window took the name atomically, the restore then answered EEXIST, this
 * threw, and the displaced owner carried on working under a name a third process held: the BR-010
 * double-writer, reached through the rewrite that exists to prevent it, and with nothing left to
 * unwind it, because the displaced owner's own release correctly declines to unlink a lock it no
 * longer recognises.
 *
 * So the replacement goes back unjudged and the attempt reports no verdict; the next round judges it
 * with the lock on disk, and `MAX_ATTEMPTS` has room for that round. The gap that remains is the
 * rename and the link — irreducible without an atomic compare-and-unlink, which POSIX does not
 * offer — and if a third process still wins it, this throws rather than proceeding and leaves the
 * displaced lock on disk under its set-aside name, where `displacedHolder` reads it before any
 * later run can take the name.
 *
 * `probe` is deliberately not a parameter. That is not a guarantee that no OS question can be asked
 * here — `livenessOf` is a module import and would compile inside this function today, as review
 * pointed out when an earlier version of the comment below claimed otherwise. What it buys is that
 * reintroducing the question takes a signature change, a change at the call site and a change to
 * this gate's mutations: a deliberate act rather than a line added to a function that already had
 * the means to hand.
 */
async function removeExactly(path: string, judged: LockRead): Promise<Removal> {
  const aside = `${path}.stale.${randomUUID()}`;
  try {
    await rename(path, aside);
  } catch (error) {
    // Another process got there first, or it was released normally in the meantime. Either way
    // this process did not reclaim anything and must not say that it did.
    if (isErrno(error, "ENOENT")) return { kind: "lost" };
    throw error;
  }

  // The run name is free on disk from here until one of the exits below, and everything between is
  // either the identity comparison or putting the file back. See the note on `probe` above for what
  // the signature does and does not guarantee about that.
  const judgedRaw = judged.kind === "absent" ? undefined : judged.raw;
  let taken: LockRead;
  try {
    taken = await readLock(aside);
  } catch (error) {
    // A read that throws is not a reason to leave the name free. `readLock` rethrows everything
    // that is not ENOENT, and this call sat outside any `try` until review pointed out where that
    // ends: an EIO on a failing disk propagated out of `acquireRunLock` with the lock path empty,
    // nothing restored, and an errno that did not even name the file now holding a possibly-live
    // lock. Put it back first; the read failure is still what gets reported, unless the restore
    // fails too, in which case its message — which names the displaced file — is the one worth
    // having.
    await restore(path, aside);
    throw error;
  }

  if (taken.kind === "absent") {
    // The set-aside file went between the rename and the read: another process is tidying, or the
    // filesystem lost it. The judged lock is off the lock path either way, which is what a
    // reclamation had to achieve, and there is nothing left to put back — reporting `lost` here
    // would deny a removal that did happen and drop the reclamation BR-035 requires be reported.
    return { kind: "removed" };
  }

  if (taken.raw === judgedRaw) {
    await unlink(aside).catch(ignoreCleanupFailure);
    return { kind: "removed" };
  }

  // Not the file that was judged, so it goes back — unjudged. See the note above.
  await restore(path, aside);
  return { kind: "disturbed" };
}

/**
 * Puts a set-aside lock back where it was taken from, or says why the tree is now wrong.
 *
 * The set-aside copy is unlinked only once the link has succeeded. The first version did it in a
 * `finally`, which runs on the throw paths too — so a restore that failed for any reason ended with
 * the live lock *deleted* rather than merely displaced, and the next run took the name alongside a
 * process still working under it. Reported by review. Both throws below leave the displaced lock on
 * disk under its set-aside name, and `displacedHolder` is what makes that more than a note in a
 * failure message: a later run reads it rather than walking past it.
 */
async function restore(path: string, aside: string): Promise<void> {
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
}

/** A lock a previous reclamation moved aside and could not put back, and what it looks like now. */
interface DisplacedLock {
  readonly at: string;
  readonly contents: RunLockContents;
  readonly verdict: LivenessVerdict;
}

/**
 * Finds a lock beside the lock path whose owner is not provably gone.
 *
 * `restore` leaves a file behind when it cannot put a lock back, and that used to be the end of it:
 * the failure told the operator where the file was, and nothing ever read it again. Review's point
 * is what happens next — the *following* invocation finds a free lock path, takes the name, and
 * runs alongside whatever is still working under the displaced lock. The failure that stopped one
 * run from colliding let the one after it collide instead, silently, which is worse.
 *
 * So the leftovers are read, through the same ladder the lock path gets (`judgeOwner`): a live owner
 * on this machine is a run in progress, another machine's lock cannot be judged from here, and a
 * lock whose owner is gone — or which never parsed — is inert. Inert ones are left alone rather than
 * deleted: deleting one could take away another process's set-aside file mid-reclamation, and litter
 * in a run directory is much the lesser problem.
 *
 * Two things wear the same name as a displaced lock, and neither is one. Both were found by review
 * after the first version of this refused on anything it saw:
 *
 * - **A reclamation in flight elsewhere.** Its set-aside file is on disk for the length of a rename,
 *   a read and a link. The caller therefore waits it out and only refuses if a leftover survives
 *   every attempt — see the loop. Refusing on first sight told the operator to wait for a run that
 *   had already finished and to remove a file that had already gone, and if they were quick enough
 *   to catch it, removing it made that process's restore fail and destroyed the lock outright.
 * - **A restore that worked, whose cleanup did not.** `restore` links the file back and only then
 *   unlinks the set-aside name, so a failing `unlink` leaves a second link to the *live* lock beside
 *   it. Nothing was displaced there at all: saying so would be false, and refusing on it would block
 *   every run of this name until the owner died. The lock at the path governs, and it gets judged by
 *   the loop in the ordinary way; this scan is only about files the path does not account for.
 */
async function displacedHolder(
  path: string,
  thisHost: string,
  probe: ProcessProbe,
): Promise<DisplacedLock | undefined> {
  const directory = dirname(path);
  const prefix = `${basename(path)}.stale.`;
  let entries: Dirent[];
  try {
    // With types, so a symlink planted at one of these names is skipped rather than followed. The
    // read below would follow it, and then a committed `lock.stale.<uuid>` pointing anywhere on
    // disk could produce a refusal about a lock that has nothing to do with this repository. Dirent
    // answers from an lstat, so a symlink is not a file here.
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }

  // Sorted so that two leftovers produce the same refusal every time it is asked for.
  const leftovers = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort();
  if (leftovers.length === 0) return undefined;

  // Read once, for the second case in the docblock: a leftover holding the same bytes as the lock
  // that is on the path is a second link to it, not a lock that was left displaced.
  const current = await readLock(path);
  for (const entry of leftovers) {
    const at = join(directory, entry);
    const read = await readLock(at);
    if (read.kind !== "lock") continue;
    if (current.kind !== "absent" && read.raw === current.raw) continue;
    const verdict = await judgeOwner(read.contents, thisHost, probe);
    if (verdict.liveness === "live" || verdict.liveness === "undecidable") {
      return { at, contents: read.contents, verdict };
    }
  }
  return undefined;
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

/**
 * Every refusal names the file, because the remedy is about a file.
 *
 * "Remove the run's lock" was the whole of the advice until review asked which one: the path is
 * derived from a repository, a layout and a run name, and an operator who has just been told a run
 * is in progress has no reason to know where awcli put it. Nothing else in a refusal is worth as
 * much as the path.
 */
function heldMessage(
  run: string,
  path: string,
  holder: RunLockContents,
  reclaimed: Reclamation | undefined,
): string {
  return `The "${run}" run is already in progress: process ${holder.owner.pid} on ${printable(holder.host)} has held its lock (${path}) since ${acquiredAtText(holder)}. ${changeNote(reclaimed)} Wait for it to finish, or start this run under a different --name.`;
}

function undecidableMessage(
  run: string,
  path: string,
  holder: RunLockContents,
  thisHost: string,
  reason: string | undefined,
  reclaimed: Reclamation | undefined,
): string {
  return `awcli will not take the lock for the "${run}" run: ${undecidableBecause(holder, thisHost, reason)}. ${changeNote(reclaimed)} If that run is finished, remove ${path}, or start this run under a different --name.`;
}

/**
 * Why the owner could not be placed — including what the probe said, when it said anything.
 *
 * The reason is what separates a refusal that will clear on its own from one that never will. A
 * container image whose `ps` does not understand `-o lstart=` answers "could not ask" on every
 * attempt for ever, and without the reason the operator is told only that awcli "could not
 * establish" something, over and over, with nothing to act on. Review flagged it as undiagnosable,
 * and that was exactly right: the probe writes a reason, and it used to be dropped one function
 * later.
 */
function undecidableBecause(
  holder: RunLockContents,
  thisHost: string,
  reason: string | undefined,
): string {
  if (holder.host !== thisHost) {
    return `its lock was taken on "${printable(holder.host)}", not on this machine ("${thisHost}"), so a process id in it means nothing here`;
  }
  const said = reason === undefined ? "" : ` (${printable(reason)})`;
  return `whether process ${holder.owner.pid} is still running could not be established on this machine${said}`;
}

/**
 * What to say about a leftover lock, and — the part review had to correct — what to ask for.
 *
 * The first version asserted that "an earlier reclamation moved a lock and could not put it back",
 * which is one of the three things a file at that name can be, and then prescribed removing it in
 * every case. Both halves were wrong for a live owner: awcli cannot tell a failed restore from a
 * reclamation still in progress from here, and telling the operator to delete a file another process
 * is about to link back is telling them to destroy a live run's lock. So the message says where the
 * file is and what is known about its owner, and asks for a removal only where a removal is the
 * remedy — the case awcli cannot resolve by itself, because the owner is on another machine or the
 * probe cannot answer.
 */
function displacedMessage(
  run: string,
  displaced: DisplacedLock,
  thisHost: string,
  reclaimed: Reclamation | undefined,
): string {
  const { at, contents, verdict } = displaced;
  const remedy =
    verdict.liveness === "live"
      ? `process ${contents.owner.pid} on ${printable(contents.host)} is still running under it. Wait for that run to finish; awcli stops refusing on that file by itself once its owner is gone, so it is not yours to remove while the run is going. Or start this run under a different --name.`
      : `${undecidableBecause(contents, thisHost, verdict.reason)}. If that run is finished, remove ${at}; if it is not, wait for it, or start this run under a different --name.`;
  return `awcli will not take the lock for the "${run}" run: there is a lock beside it at ${at}, left there either by a reclamation that could not put it back or by one that is still in progress elsewhere — it was still there after ${MAX_ATTEMPTS} attempts — and ${remedy} ${changeNote(reclaimed)}`;
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

/**
 * Turns "cannot write here" into a sentence about the directory, or leaves the error alone.
 *
 * An unwritable repository is the one failure on this path an operator can fix without knowing
 * anything about awcli, and until review pointed it out they got `EACCES` and a stack trace for it
 * — from `mkdir` if the runtime directory does not exist yet, and from the staging write if it does.
 * Both call sites go through here so the two cases cannot drift apart.
 */
function refuseUnwritable(error: unknown, directory: string): void {
  if (isErrno(error, "EACCES") || isErrno(error, "EPERM") || isErrno(error, "EROFS")) {
    throw new Error(
      `awcli cannot write a run's lock in ${directory} (${errnoOf(error) ?? "permission denied"}): that directory is not writable. Check its permissions, or run against a repository this user can write to.`,
      { cause: error },
    );
  }
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
 *
 * The bidirectional controls go with them, which review had to point out twice over: U+202E and its
 * neighbours are not control characters by the C0/C1 definition, and they reverse the *rendering* of
 * everything after them. A host of "evil\u202Emoc.elpmaxe" displays as if it read example.com, so a
 * refusal that quotes it tells the operator to go and look at the wrong machine. Same class as the
 * escape sequences, different range.
 */
function printable(value: string): string {
  const stripped = value.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g,
    "?",
  );
  return stripped.length > PRINTABLE_LIMIT
    ? `${stripped.slice(0, PRINTABLE_LIMIT)}...`
    : stripped;
}

const PRINTABLE_LIMIT = 64;
