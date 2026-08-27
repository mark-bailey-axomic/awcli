#!/usr/bin/env bash
# Prove the run-lock tests are gates. Every criterion on AWCLI-07 is a claim about a decision that
# is easy to get wrong in a way that still passes a happy-path test: a lock that is always taken,
# always reclaimed, or never reclaimed all look fine until the day they matter. AWCLI-00 shipped a
# ticked criterion whose check was structurally incapable of failing; this script is the answer to
# that, for this unit.
#
# Each mutation is a plausible wrong implementation, not a syntax error. "Trust the pid" is what
# you get from writing the obvious lock file; "reclaim anything older than an hour" is what a
# reviewer suggests when a stale lock blocks them; "unlink the path" is the release everyone writes
# first; and everything under a "found in review" heading is code that was actually here and shipped
# for review before being caught. Those headings deliberately name the round rather than a count —
# the sections have grown on every round, and a number in a comment is one more thing to get wrong.
#
# A mutation whose anchor no longer matches fails the script rather than being skipped. A refactor
# that moves this code should therefore break here loudly: a silently skipped mutation is exactly
# the hole this exists to close. It has already fired once for real, on this ticket, when a
# refactor renamed a call it anchored on.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=scripts/lib/mutation-gate.sh
source "$REPO_ROOT/scripts/lib/mutation-gate.sh"

mutation_gate_init \
  "test/runtime/run-lock.test.ts test/runtime/run-identity.test.ts test/runtime/process-probe.test.ts test/runtime/process-probe-ps.test.ts test/runtime/run-lock-fs-faults.test.ts" \
  src/runtime/run-lock.ts src/runtime/run-identity.ts src/runtime/process-probe.ts

# ── Scenario: Two runs of the same name cannot overlap ───────────────────────────────────────
# The lock is taken regardless of who holds it. This is the shape of every lock written without a
# liveness question at all.
expect_red "Two runs of the same name cannot overlap" src/runtime/run-lock.ts \
  's/if \(existing\.kind === "lock" && verdict\.liveness === "live"\)/if (false \&\& verdict.liveness === "live")/'

# ── Scenario: Differently named runs may overlap ─────────────────────────────────────────────
# One lock file for the whole repository, which is what you get from treating the lock as a
# property of the repository rather than of the run name.
expect_red "Differently named runs may overlap" src/runtime/run-identity.ts \
  's/return join\(runDirectory\(repositoryPath, runName\), "lock"\);/void runName; return join(runtimeRoot(repositoryPath), "lock");/'

# ── Scenario: A lock left by a killed run is reclaimed automatically ─────────────────────────
# Every existing lock refuses. A correct-looking conservative choice, and the one that makes a
# rebooted machine lose the run name for ever.
expect_red "A lock left by a killed run is reclaimed automatically" src/runtime/run-lock.ts \
  's/if \(existing\.kind === "lock" && verdict\.liveness === "live"\)/if (existing.kind === "lock")/'

# Reclamation happens but says nothing. The lock works; the operator cannot tell a reclaimed run
# from a first one, which BR-035 explicitly forbids.
expect_red "reclamation is reported, never silent" src/runtime/run-lock.ts \
  's/          reclaimed = \{\n            reason,/          reclaimed = undefined; void {\n            reason,/'

# ── Scenario: A slow run keeps its lock ──────────────────────────────────────────────────────
# Staleness decided by the lock's age instead of by its owner — the implementation the ticket's
# constraint rules out by name, and the one a reviewer proposes when a stale lock blocks them.
expect_red "A slow run keeps its lock" src/runtime/run-lock.ts \
  's/              : await livenessOf\(existing\.contents\.owner, probe\);/              : Date.now() - existing.contents.acquiredAt > 60 * 60 * 1000 ? { liveness: "gone", reason: undefined } : { liveness: "live", reason: undefined };/'

# ── A reused process id does not read as the original owner ──────────────────────────────────
# Trust the pid alone. This is the lock file everyone writes first, and on a busy machine it starts
# reading dead runs as live within minutes.
expect_red "a reused process id does not read as the original owner" src/runtime/process-probe.ts \
  's/    liveness: answer\.identity\.startedAt === owner\.startedAt \? "live" : "different",/    liveness: "live",/'

# The other half of the same criterion: self must be identified the same way as anyone else, or a
# live owner fails to match its own recorded identity and every lock reads as stale.
expect_red "a process's own identity comes from the same source as any other's" src/runtime/process-probe.ts \
  's/ownIdentity \?\?= systemProcessProbe\.identify\(process\.pid\)\.then\(\(answer\) => \{/ownIdentity ??= Promise.resolve({ pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000) }).then((answer) => { return answer; }).then((answer) => {/' \
  's/      if \(answer\.kind === "running"\) return answer\.identity;/      if ("pid" in answer) return answer;\n      if (answer.kind === "running") return answer.identity;/'

# ── The lock is released through the disposal stack, on every exit path ──────────────────────
# Acquired without registering. The lock is taken correctly and outlives the run.
expect_red "the lock is released through the disposal stack" src/runtime/run-lock.ts \
  's/const lock = await stack\.acquire\(acquisition\);/const lock = await acquisition.open();/'

# Registered, but preserved rather than destroyed. BR-021 states the disposition per resource:
# worktrees are preserved, the lock never is.
expect_red "the lock is destroyed on release, not preserved" src/runtime/run-lock.ts \
  's/    disposition: "destroy",/    disposition: "preserve",/'

# ── The release lets go of this run's lock, and only this run's ──────────────────────────────
# Unlink whatever is at the path. Deletes a live run's lock when this one's was reclaimed from
# under it, letting a third run start alongside it.
expect_red "release does not delete a lock that is no longer ours" src/runtime/run-lock.ts \
  's/  if \(current\.kind === "absent"\) return;/  if (current.kind === "absent") return;\n  await unlink(held.path).catch(ignoreMissing);\n  if (current) return;/'

# ── An explicit run name is validated, never rewritten ──────────────────────────────────────
# Slugify what the operator typed. Two distinct --name values can then collide on one lock file,
# which is two runs believing they hold different locks.
expect_red "an explicit run name is refused rather than rewritten" src/runtime/run-identity.ts \
  's/    : validateRunName\(explicit\);/    : defaultRunName(explicit);/'

# An empty --name falls through to the derived default instead of being reported. A shell variable
# that did not expand then silently sends the run at whatever the workflow file is called.
expect_red "an empty --name is refused rather than defaulted" src/runtime/run-identity.ts \
  's/  return explicit === undefined\n    \? defaultRunName/  return explicit === undefined || explicit.length === 0\n    ? defaultRunName/'

# ── The derived default is deterministic ────────────────────────────────────────────────────
# A per-invocation suffix. Every run becomes a different writer and BR-010 stops firing at all.
expect_red "the derived run name is deterministic" src/runtime/run-identity.ts \
  's/^  const slug = stem/  let slug = stem/m' \
  's/  if \(slug\.length === 0\) \{/  slug = (slug + "-" + process.hrtime.bigint()).slice(0, 60);\n  if (slug.length === 0) {/'

# ── A run name may not collide with the layout's own paths, or with git's ref rules ─────────
expect_red "a reserved run name is refused" src/runtime/run-identity.ts \
  's/  if \(RESERVED_RUN_NAMES\.includes\(name\)\) \{/  if (false) {/'

# `.lock` passes the edge-character rule because `k` is a letter, so it needs its own check — git
# refuses the branch at creation time, after the run has taken its lock and started work.
expect_red "a name git will refuse as a branch is refused here" src/runtime/run-identity.ts \
  's/  if \(name\.endsWith\("\.lock"\)\) \{/  if (false) {/'

# A directory on a case-insensitive filesystem and a branch on a case-sensitive one must agree, or
# `Triage` and `triage` are one lock file and two branches.
expect_red "a run name that only differs by case is refused" src/runtime/run-identity.ts \
  's/  if \(name !== name\.toLowerCase\(\)\) \{/  if (false) {/'

# ── Found in review: the four defects that shipped, and must not come back ──────────────────
#
# Blind rename-aside. Judged one file, removed whatever was at the path. Two runs meeting the same
# stale lock after a reboot — the ordinary case reclamation exists for — could both end up holding
# the name, because the second removed the first's *live* lock and linked its own over the gap.
#
# One mutation where there were two. The second stood in for the version of this fix that compared
# inode numbers — CI on ext4 caught that one: reclaiming the stale lock frees its inode, the next
# staging file is handed the same number, and the winner's *live* lock compared equal to the dead
# one. Both mutations now produce the same code, because the absent case moved to its own branch
# above this one, and two spellings of one mutation is padding rather than coverage. The `|| true`
# form is kept: it is what any identity that can collide — an inode, a size, an mtime — looks like
# from here, and macOS does not reproduce the real collision.
expect_red "the removal's identity check cannot be fooled by a recycled identifier" src/runtime/run-lock.ts \
  's/  if \(taken\.raw === judgedRaw\) \{/  if (taken.raw === judgedRaw || true) {/'

# An unanswerable probe read as "the owner is gone". A `ps` that timed out on a loaded box, an
# EAGAIN from fork, or `ps` missing from a container image all evicted a live owner's lock — and
# load-correlated, so it fired exactly when a second run was there to collide with.
expect_red "a probe that cannot answer does not read as a dead process" src/runtime/process-probe.ts \
  's/  if \(answer\.kind === "unknown"\) \{\n    return \{ liveness: "undecidable", reason: answer\.reason \};\n  \}/  if (answer.kind === "unknown") return { liveness: "gone", reason: undefined };/'

# Another machine's pid judged against this machine's process table. Reclaimed a synced-checkout
# lock and told the operator its owner "was killed", which was false.
expect_red "a lock from another machine is not judged by local pids" src/runtime/run-lock.ts \
  's/            : existing\.contents\.host !== contents\.host/            : false/'

# The `continue` that jumped the attempt bound. A dangling symlink at the lock path answers EEXIST
# to `link` and ENOENT to `readFile` at once, so awcli spun at startup burning a core. Both halves
# are mutated: without the symlink refusal the loop bound is what has to stop it.
expect_red "the acquisition loop is bounded on every path" src/runtime/run-lock.ts \
  's/  if \(stats\.isSymbolicLink\(\)\) \{/  if (false) {/' \
  's/      for \(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt\+\+\) \{/      for (let attempt = 1; ; attempt++) {/'

# ── Found in the third, fourth and fifth review rounds: more that shipped ───────────────────
#
# Symlink refusal that looks only at the run directory. `mkdir` with `recursive` follows an existing
# symlink at any level, so a committed symlink at `.awcli` or `.awcli/run` put the lock outside the
# repository and the check saw a real directory at the level it inspected.
expect_red "a symlink above the run directory is refused too" src/runtime/run-lock.ts \
  's/for \(const ancestor of runDirectoryAncestors\(repositoryPath, runName\)\) \{/for (const ancestor of runDirectoryAncestors(repositoryPath, runName).slice(-1)) {/'

# The re-judge inside a reclamation is gone as of the third review round, and so are the three
# mutations that pinned how it judged. It ran with the run name free on disk — `livenessOf`, and on
# macOS a `ps` spawn bounded only by its own two-second timeout — and any run starting in that
# window took the name while this one still believed it was reclaiming. What replaces those three is
# the property that the file goes back *unjudged*: the mutation below deletes the restore, which is
# what judging-then-removing looks like from the outside.
expect_red "a lock taken aside that is not the one judged goes back untouched" src/runtime/run-lock.ts \
  's/  \/\/ Not the file that was judged, so it goes back — unjudged\. See the note above\.\n  await restore\(path, aside\);\n  return \{ kind: "disturbed" \};/  await unlink(aside).catch(ignoreCleanupFailure);\n  return { kind: "removed" };/'

# A staging write that fails part-way through — ENOSPC, EIO — creates the file and then fails, so
# skipping the cleanup leaves a staging file nobody will ever link or read accumulating in the run's
# directory. EEXIST is deliberately not cleaned: that file is not ours.
expect_red "a failed staging write leaves nothing behind" src/runtime/run-lock.ts \
  's/    if \(!isErrno\(error, "EEXIST"\)\) await unlink\(staging\)\.catch\(ignoreMissing\);\n    refuseUnwritable/    refuseUnwritable/'

# The ancestor walk used to stop by comparing against the repository path as a string, which is
# wrong for the same directory spelled differently: `--repo /repo/` never equals `/repo`, so the
# walk carried on past the repository and inspected paths above it.
expect_red "the ancestor walk stays inside the repository" src/runtime/run-lock.ts \
  's/  for \(const ancestor of runDirectoryAncestors\(repositoryPath, runName\)\) \{/  const runDir = dirname(runLockPath(repositoryPath, runName));\n  const walked: string[] = [];\n  for (let c = runDir; c !== repositoryPath; c = dirname(c)) {\n    walked.unshift(c);\n    if (dirname(c) === c) break;\n  }\n  for (const ancestor of walked) {/'

# The terminal failure claimed "Nothing has been changed" while a reclamation may already have
# deleted a file. The same defect as the two refusal messages a round earlier, missed here.
expect_red "no message hardcodes a claim that nothing changed" src/runtime/run-lock.ts \
  's/the moment it acted\. \$\{changeNote\(reclaimed\)\} Try again;/the moment it acted. Nothing has been changed; try again,/'

# ── Found in the second full review round: defects in the remediation itself ─────────────────
# Two of these were the blockers, and both were introduced by the fix for an earlier one. The
# pattern is worth naming: the dangerous code on this ticket has consistently been the error
# handling of a correction, not the original mistake.

# The set-aside lock is deleted even when it could not be put back — so a live run's lock vanishes
# rather than being displaced, and the next run takes the name alongside it. This is the `finally`
# the first version had.
expect_red "a lock that could not be put back is left on disk" src/runtime/run-lock.ts \
  's/    throw new Error\(\n      `awcli set the lock for a run at/    await unlink(aside).catch(ignoreCleanupFailure);\n    throw new Error(\n      `awcli set the lock for a run at/'

# Tidying up the staging file becomes the outcome of an acquisition that already succeeded, so a
# lock is taken and then reported as a failure — and nothing ever releases it.
expect_red "tidying up cannot turn a lock that was taken into a failure" src/runtime/run-lock.ts \
  's/    await unlink\(staging\)\.catch\(ignoreCleanupFailure\);/    await unlink(staging).catch(ignoreMissing);/'

# The reclamation on the final attempt is thrown away: the stale lock is deleted, the path is left
# free, and the operator is told the name is being fought over when nothing holds it.
expect_red "a reclamation on the last attempt is used, not discarded" src/runtime/run-lock.ts \
  's/      if \(reclaimed !== undefined\) \{\n        await refuseSymlink/      if (false) {\n        await refuseSymlink/'

# A filesystem that answers ENOTSUP or EMLINK reaches the operator as a bare errno.
expect_red "a filesystem that will not hard-link is explained" src/runtime/run-lock.ts \
  's/      isErrno\(error, "ENOTSUP"\) \|\|\n/\n/' \
  's/    if \(isErrno\(error, "EMLINK"\)\) \{/    if (false) {/'

# A lock file's bytes go straight to the terminal, so a repository can repaint an operator's screen
# and show them a refusal awcli never wrote.
expect_red "a lock file's bytes are not printed to the terminal unfiltered" src/runtime/run-lock.ts \
  's/  const stripped = value\.replace\(/  const stripped = String(/'

# A refusal throws while formatting itself, because `acquiredAt` came off disk.
expect_red "a lock's unreadable acquisition time is reported, not thrown on" src/runtime/run-lock.ts \
  's/  return Number\.isFinite\(at\.getTime\(\)\)/  return true || Number.isFinite(at.getTime())/'

# `ps` exiting 1 is trusted on its own. busybox's `ps` does not take `-o lstart=` and exits 1 saying
# so, which would evict a live owner's lock on every ask in any image that ships it.
expect_red "a ps that refuses the question does not read as 'no such process'" src/runtime/process-probe.ts \
  's/    if \(failure\.code === 1 && failure\.killed !== true && complaint\.length === 0\) \{/    if (failure.code === 1 \&\& failure.killed !== true) {/'

# The locale pin. Anchored on a mutation the mocked adapter suite catches on every platform: the
# real-locale test can only run where the C library has fr_FR, which is not most of CI.
expect_red "the locale of the question is pinned" src/runtime/process-probe.ts \
  's/      env: \{ \.\.\.process\.env, LC_ALL: "C" \},/      env: { ...process.env },/'

# An id no operating system can assign is asked about anyway, and `ps` complaining about it now
# comes back as "could not decide" — a refusal no operator can clear.
# Anchored on the predicate rather than on `identify`: Linux answers out-of-range ids from /proc,
# where the range check makes no difference, so the first version of this mutation survived on Linux
# CI and passed on macOS.
expect_red "an out-of-range process id is answered without asking" src/runtime/process-probe.ts \
  's/ && pid <= PID_CEILING//'

# ── Found in the third full review round: the remediation again ──────────────────────────────
# The same pattern for the third time: the dangerous code is the error handling of a correction.
# Every one of these is a path the previous round's fix opened or left uncovered.

# The read of the set-aside file sat outside any `try`, and `readLock` rethrows everything that is
# not ENOENT — so an EIO propagated out of the acquisition with the lock path *empty* and the
# displaced file unnamed.
expect_red "a set-aside lock is put back before a failed read is reported" src/runtime/run-lock.ts \
  's/    await restore\(path, aside\);\n    throw error;/    throw error;/'

# The EEXIST half of "leave the displaced lock on disk" had no test and no mutation: only ENOSPC was
# staged, and the mutation below anchored on the other throw. Re-adding the unlink here would
# destroy a live lock again with everything green — which is the failure this whole file exists to
# make impossible. It is also the likelier of the two: EEXIST is what a third process linking its
# own lock into the gap looks like from here.
expect_red "a lock displaced by a third process is left on disk too" src/runtime/run-lock.ts \
  's/      throw new Error\(\n        `The lock for a run at \$\{path\} was replaced/      await unlink(aside).catch(ignoreCleanupFailure);\n      throw new Error(\n        `The lock for a run at ${path} was replaced/'

# A lock a failed restore left behind was named in that failure and then never read again, so the
# *next* invocation found a free lock path and took the name alongside whatever was still working
# under the displaced file. The failure that stopped one collision permitted the next one.
expect_red "a displaced lock is read before the run name is treated as free" src/runtime/run-lock.ts \
  's/      const displaced = await displacedHolder\(path, probe\);/      const displaced = undefined; void displacedHolder;/'

# And the other direction of that check, which matters just as much: a displaced lock whose owner is
# gone is inert, and refusing on one would make a run name permanently unusable — the failure BR-035
# exists to prevent, arrived at from the side.
expect_red "a displaced lock whose owner is gone does not block the name" src/runtime/run-lock.ts \
  's/    if \(verdict\.liveness === "live" \|\| verdict\.liveness === "undecidable"\) \{/    if (true) {/'

# An unwritable repository reached the operator as a bare EACCES and a stack trace. It is the one
# failure on this path they can fix without knowing anything about awcli, and the remedy is about a
# directory, so the message has to name one.
expect_red "an unwritable repository is explained rather than passed on" src/runtime/run-lock.ts \
  's/    if \(!isErrno\(error, "EEXIST"\)\) await unlink\(staging\)\.catch\(ignoreMissing\);\n    refuseUnwritable\(error, dirname\(path\)\);/    if (!isErrno(error, "EEXIST")) await unlink(staging).catch(ignoreMissing);/'

# A reclamation followed by a refusal is still a reclamation (BR-035 has no exception for it), and
# the channel that carries it off the refusal path had no mutation of its own.
expect_red "a refusal carries a reclamation made on the way to it" src/runtime/run-lock.ts \
  's/    refusal = \{ ok: false, kind, run: request\.runName, holder, message, reclaimed \};/    refusal = { ok: false, kind, run: request.runName, holder, message, reclaimed: undefined };/'

# A name derived from a workflow reference, refused with the wording written for a name the operator
# typed — "choose another name", of a name nobody chose and no flag to change.
expect_red "a refused derived name says it was derived" src/runtime/run-identity.ts \
  's/  if \(validated\.ok\) return validated;/  return validated;/'

# The probe writes down why it could not answer, and the refusal used to drop it — leaving "could
# not be established" for both a `ps` that is missing for good and a machine that was briefly busy.
expect_red "a refusal says what the probe could not answer" src/runtime/run-lock.ts \
  's/  const said = reason === undefined \? "" : ` \(\$\{printable\(reason\)\}\)`;/  const said = "";/'

mutation_gate_finish "each run-lock criterion has a test that fails when it is broken"
