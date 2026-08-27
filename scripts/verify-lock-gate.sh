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
# first; and everything below the criteria is code that was actually here and shipped for review
# before being caught.
#
# The headings group by what the defect *was*, not by when it was found. They used to name review
# rounds, in two incompatible schemes at once, so the sections read out of order and "third" meant
# two different things in one file — and a new heading had to pick a scheme every time. What a reader
# needs is what class of mistake a mutation stands for.
#
# A mutation whose anchor no longer matches fails the script rather than being skipped. A refactor
# that moves this code should therefore break here loudly: a silently skipped mutation is exactly
# the hole this exists to close. It has fired for real on this ticket, more than once, always
# because a remediation moved code a mutation was anchored on. How many times is deliberately not
# recorded — the paragraph above says why a number in a comment is one more thing to get wrong, and
# review found this line and the ticket disagreeing about it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=scripts/lib/mutation-gate.sh
source "$REPO_ROOT/scripts/lib/mutation-gate.sh"

mutation_gate_init \
  "test/runtime/run-lock.test.ts test/runtime/run-identity.test.ts test/runtime/process-probe.test.ts test/runtime/process-probe-ps.test.ts test/runtime/run-lock-fs-faults.test.ts test/runtime/printable.test.ts" \
  src/runtime/run-lock.ts src/runtime/run-identity.ts src/runtime/process-probe.ts \
  src/runtime/printable.ts

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
  's/        reclamations\.push\(\{\n          reason,/        void ({\n          reason,/'

# ── Scenario: A slow run keeps its lock ──────────────────────────────────────────────────────
# Staleness decided by the lock's age instead of by its owner — the implementation the ticket's
# constraint rules out by name, and the one a reviewer proposes when a stale lock blocks them.
expect_red "A slow run keeps its lock" src/runtime/run-lock.ts \
  's/            : await judgeOwner\(existing\.contents, thisHost, probe\);/            : Date.now() - existing.contents.acquiredAt > 60 * 60 * 1000 ? { liveness: "gone", reason: undefined } : { liveness: "live", reason: undefined };/'

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
# The four mutations below — reserved, `.lock`, case, and the unfiltered echo — are anchored inside
# `firstProblem` and its message table, since the run name's ladder and a slot's became one ladder
# with two message tables: AWCLI-13 needs the same rules for a slot, and a second hand-written copy
# would have been a weaker copy. Two consequences, and the second is the one worth writing down.
#
# Each still proves the run name's criterion, because this gate's suite is the run name's own:
# run-identity.test.ts asserts the problem discriminant for each of these rungs against a run name,
# so breaking the rung turns it red on that evidence alone. What none of them proves is anything
# about a *slot* — the mirror of the note at the same section of verify-workspace-gate.sh, which
# cannot prove the run-name half. Neither gate is short a check; the two suites are, between them,
# where both halves are asserted. What would be wrong is reading either set of mutations as covering
# both kinds of name because the code they break is now shared.
expect_red "a reserved run name is refused" src/runtime/run-identity.ts \
  's/  if \(reserved\.includes\(name\)\) return "reserved";/  if (false) return "reserved";/'

# `.lock` passes the edge-character rule because `k` is a letter, so it needs its own check — git
# refuses the branch at creation time, after the run has taken its lock and started work.
expect_red "a name git will refuse as a branch is refused here" src/runtime/run-identity.ts \
  's/  if \(name\.endsWith\("\.lock"\)\) return "git-reserved-suffix";/  if (false) return "git-reserved-suffix";/'

# A directory on a case-insensitive filesystem and a branch on a case-sensitive one must agree, or
# `Triage` and `triage` are one lock file and two branches.
expect_red "a run name that only differs by case is refused" src/runtime/run-identity.ts \
  's/  if \(name !== name\.toLowerCase\(\)\) return "not-lowercase";/  if (false) return "not-lowercase";/'

# ── Defects in the lock's own reasoning ─────────────────────────────────────────────────────
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
  's/  if \(taken\.raw === judged\.raw\) \{/  if (taken.raw === judged.raw || true) {/'

# An unanswerable probe read as "the owner is gone". A `ps` that timed out on a loaded box, an
# EAGAIN from fork, or `ps` missing from a container image all evicted a live owner's lock — and
# load-correlated, so it fired exactly when a second run was there to collide with.
expect_red "a probe that cannot answer does not read as a dead process" src/runtime/process-probe.ts \
  's/  if \(answer\.kind === "unknown"\) \{\n    return \{ liveness: "undecidable", reason: answer\.reason \};\n  \}/  if (answer.kind === "unknown") return { liveness: "gone", reason: undefined };/'

# Another machine's pid judged against this machine's process table. Reclaimed a synced-checkout
# lock and told the operator its owner "was killed", which was false. Anchored inside `judgeOwner`
# since the two copies of this ladder became one, so it now covers the leftover scan as well as the
# lock path — the second copy had already drifted from the first once.
expect_red "a lock from another machine is not judged by local pids" src/runtime/run-lock.ts \
  's/  if \(holder\.host !== thisHost\) \{/  if (false) {/'

# The `continue` that jumped the attempt bound. A dangling symlink at the lock path answers EEXIST
# to `link` and ENOENT to `readFile` at once, so awcli spun at startup burning a core. Both halves
# are mutated: without the symlink refusal the loop bound is what has to stop it.
expect_red_by_timeout "the acquisition loop is bounded on every path" src/runtime/run-lock.ts \
  's/  if \(stats\.isSymbolicLink\(\)\) \{/  if (false) {/' \
  's/      for \(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt\+\+\) \{/      for (let attempt = 1; ; attempt++) {/'

# ── Defects in what the lock does to the filesystem ─────────────────────────────────────────
#
# Symlink refusal that looks only at the run directory. `mkdir` with `recursive` follows an existing
# symlink at any level, so a committed symlink at `.awcli` or `.awcli/run` put the lock outside the
# repository and the check saw a real directory at the level it inspected.
expect_red "a symlink above the run directory is refused too" src/runtime/run-lock.ts \
  's/for \(const ancestor of runDirectoryAncestors\(repositoryPath, runName\)\) \{/for (const ancestor of runDirectoryAncestors(repositoryPath, runName).slice(-1)) {/'

# The re-judge inside a reclamation is gone, and so are the three
# mutations that pinned how it judged. It ran with the run name free on disk — `livenessOf`, and on
# macOS a `ps` spawn bounded only by its own two-second timeout — and any run starting in that
# window took the name while this one still believed it was reclaiming. What replaces those three is
# the property that the file goes back *unjudged*, in two mutations rather than one: a single
# replacement changed two things at once, so the weaker of the two wrong implementations was pinned
# by nothing.
#
# The strong one: the replacement is deleted rather than put back, which is what
# judging-then-removing looks like from the outside.
expect_red "a lock taken aside that is not the one judged goes back untouched" src/runtime/run-lock.ts \
  's/  \/\/ Not the file that was judged, so it goes back — unjudged\. See the note above\.\n  await restore\(path, aside\);\n  return \{ kind: "kept", why: "replaced" \};/  await unlink(aside).catch(ignoreCleanupFailure);\n  return { kind: "removed" };/'

# And the weak one, which is the likelier mistake: the file goes back correctly and the attempt
# reports a reclamation anyway. Nothing on disk is wrong; the operator is told a stale lock was
# destroyed when the lock is sitting there untouched, and BR-035 cuts both ways.
expect_red "a lock that was put back is not reported as reclaimed" src/runtime/run-lock.ts \
  's/  await restore\(path, aside\);\n  return \{ kind: "kept", why: "replaced" \};/  await restore(path, aside);\n  return { kind: "removed" };/'

# The set-aside file gone before it could be read is a removal — the judged lock is off the lock
# path, which is what the reclamation had to achieve. Reporting a loss instead drops the reclamation
# BR-035 requires be reported. This branch arrived with neither a test nor a mutation.
expect_red "a set-aside lock that has already gone still counts as removed" src/runtime/run-lock.ts \
  's/    return \{ kind: "removed" \};\n  \}\n\n  if \(taken\.raw === judged\.raw\)/    return { kind: "kept", why: "released" };\n  }\n\n  if (taken.raw === judged.raw)/'

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
  's/them\. \$\{changeNote\(reclamations\)\}/them. Nothing has been changed./'

# A throw that follows a reclamation drops the note entirely, so the stale lock is destroyed and the
# operator sees a bare errno. The one exit `changeNote` had never been applied to.
expect_red "a failure after a reclamation still reports it" src/runtime/run-lock.ts \
  's/    if \(reclamations\.length > 0\) \{\n      throw new Error\(/    if (false) {\n      throw new Error(/'

# ── Defects in the error handling of a correction ────────────────────────────────────────────
# The pattern worth naming on this unit: every blocking finding after the first was inside a fix
# written for an earlier one, on a path that only opens when something has already gone wrong.

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
  's/      if \(await writeIfAbsent\(path, rescueRaw\)\) \{/      if (false) {/'

# And the narrower version of that same fix, which is what shipped for a while: the rescue create
# gated on a reclamation. The other route to a free path on the last attempt — a holder that released
# while this run was looking — still fell out of the loop and threw with the name free and nothing
# holding it. The fix had covered only the case that had a test.
expect_red "a name that came free without a reclamation is taken too" src/runtime/run-lock.ts \
  's/      if \(await writeIfAbsent\(path, rescueRaw\)\) \{/      if (reclamations.length > 0 \&\& (await writeIfAbsent(path, rescueRaw))) {/'

# The exhaustion message names the route that was actually taken. "The file kept changing" described
# both routes and fitted neither, and reported a live holder repeatedly winning the race as a
# churning file — sending the operator to look for something outside awcli.
expect_red "the exhaustion says which way the attempts were spent" src/runtime/run-lock.ts \
  's/        inconclusive === "released"/        false/'

# A filesystem that answers ENOTSUP or EMLINK reaches the operator as a bare errno.
expect_red "a filesystem that will not hard-link is explained" src/runtime/run-lock.ts \
  's/      isErrno\(error, "ENOTSUP"\) \|\|\n/\n/' \
  's/    if \(isErrno\(error, "EMLINK"\)\) \{/    if (false) {/'

# A lock file's bytes go straight to the terminal, so a repository can repaint an operator's screen
# and show them a refusal awcli never wrote.
expect_red "a lock file's bytes are not printed to the terminal unfiltered" src/runtime/printable.ts \
  's/  const stripped = value\.replace\(UNPRINTABLE, "\?"\);/  const stripped = String(value);/'

# The sanitizer one class short. The bidi controls are not control characters by the C0/C1
# definition and reverse how the rest of a message reads; the zero-width and invisible-format
# characters make two different values render identically. Each was added after the ranges already
# there turned out not to cover the next thing tried, which is the argument for the mutation.
expect_red "the sanitizer covers more than the control characters" src/runtime/printable.ts \
  's/\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff//'

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
  's/ && pid < PID_CEILING//'

# ── The same, one layer in: paths a correction opened or left uncovered ─────────────────────

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
  's/      throw new Error\(\n        `The lock for a run at \$\{path\} was replaced/      await unlink(aside).catch(ignoreCleanupFailure);\n      throw new Error(\n        `The lock for a run at \${path} was replaced/'

# A lock a failed restore left behind was named in that failure and then never read again, so the
# *next* invocation found a free lock path and took the name alongside whatever was still working
# under the displaced file. The failure that stopped one collision permitted the next one.
expect_red "a displaced lock is read before the run name is treated as free" src/runtime/run-lock.ts \
  's/        const displaced = await displacedHolder\(path, thisHost, probe, inertLeftovers\);/        const displaced = undefined; void displacedHolder;/'

# And the other direction of that check, which matters just as much: a displaced lock whose owner is
# gone is inert, and refusing on one would make a run name permanently unusable — the failure BR-035
# exists to prevent, arrived at from the side.
expect_red "a displaced lock whose owner is gone does not block the name" src/runtime/run-lock.ts \
  's/    if \(verdict\.liveness === "live" \|\| verdict\.liveness === "undecidable"\) \{/    if (true) {/'

# ── The surroundings of a correction, which do not move with it ─────────────────────────────
# A restructure moves the ground under everything that referred to the old shape. These are in the
# leftover scan, which was added to close one finding and arrived with three of its own.
#
# A leftover is refused on first sight rather than waited out. A reclamation in flight elsewhere has
# a set-aside file on disk for a rename, a read and a link — so this told the operator to wait for a
# run that had already finished and to remove a file that had already gone, and removing it in that
# window made the restore in that other process fail, and destroyed the lock outright.
expect_red "a reclamation in progress elsewhere is waited out, not refused" src/runtime/run-lock.ts \
  's/          if \(attempt < MAX_ATTEMPTS\) continue;/          if (false) continue;/'

# A second link to the *live* lock read as a lock that was left displaced. `restore` unlinks the
# set-aside name only after the link succeeds, so a failing cleanup leaves one — and refusing over it
# says a reclamation could not put a lock back, which is false, and blocks every run of the name
# until the owner dies.
expect_red "a leftover that is a second link to the live lock is not a displaced one" src/runtime/run-lock.ts \
  's/    if \(current\.kind !== "absent" && read\.raw === current\.raw\) continue;/    if (false) continue;/'

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

# ── The messages an operator acts on ────────────────────────────────────────────────────────
# Everything under here is a message or an identity check, and every one of them was found saying
# something narrower or wider than the truth. They are gated because a message is this unit's whole
# interface: a refusal that misdescribes what happened sends the operator somewhere else.

# The reclamation sentence BR-035 exists for, with neither the file it removed nor when the lock was
# taken. "A stale lock" is not something anyone can check against the run they thought was running.
expect_red "the reclamation says which lock went and when it was taken" src/runtime/run-lock.ts \
  's/  return `Reclaimed a stale lock on the "\$\{run\}" run: the lock at \$\{path\}\$\{since\} was removed because \$\{why\}\.`;/  return `Reclaimed a stale lock on the "\${run}" run: \${why}.`;/'

# Only the last of several reclamations reported, followed by a claim about everything else. Two are
# reachable in one acquisition, and this is the "nothing else has been changed" defect one layer in.
expect_red "a message accounts for every stale lock the run destroyed" src/runtime/run-lock.ts \
  's/  return `\$\{reclamations\.map\(\(reclamation\) => reclamation\.message\)\.join\(" "\)\} Apart/  return `\${reclamations.at(-1)?.message ?? ""} Apart/'

# The filename of a leftover goes into a refusal unsanitised. It comes out of a directory listing, where
# anything but NUL and a slash is legal, and it is the one message that asks the operator to act on a
# file — so an escape sequence in it repaints the screen they are reading the remedy on.
expect_red "a leftover is named without what a terminal would act on" src/runtime/run-lock.ts \
  's/        shown: join\(directory, printable\(entry, SHOWN_NAME_LIMIT\)\),/        shown: join(directory, entry),/'

# The name a run was refused for, echoed back with its control characters — in the branch that
# refuses a name *for* holding one.
expect_red "a refused run name is not echoed back unfiltered" src/runtime/run-identity.ts \
  's/        `"\$\{printable\(name\)\}" is not usable as a run name/        `"\${name}" is not usable as a run name/'

# The derived-name refusal forwarding the remedy from the validator as well as its reason, so the
# operator is told to choose another name for a name they never chose.
expect_red "a derived name is refused with a remedy that fits" src/runtime/run-identity.ts \
  's/\$\{validated\.reason\}`,/\${validated.message}`,/'

# The stderr of `ps` itself, carried into a reason that reaches a terminal through two consumers.
expect_red "output from another program does not reach the terminal unfiltered" src/runtime/process-probe.ts \
  's/printable\(complaint\.split\("\\n"\)\[0\] \?\? "", COMPLAINT_LIMIT\)/complaint.split("\\n")[0] ?? ""/'

# ── Identity, and the failures an operator can actually fix ─────────────────────────────────

# The reclaiming attempt falls out of the iteration instead of taking the name, so the process that
# just freed the name sleeps through the backoff without holding it, and a run starting in that
# window takes it. The window is self-inflicted, which is the recurring defect on this unit.
expect_red "the attempt that frees a name takes it" src/runtime/run-lock.ts \
  's/          \/\/ Reclaimed and taken in one attempt: nothing got in between\.\n          return \{ run: request\.runName, path, contents, raw \};/          void 0;/'

# The release identifying its own lock by three fields off the parse rather than by the bytes. `host`
# is not among the three, so a synced checkout can present a lock from another machine matching on
# all of them and have it unlinked.
expect_red "the release identifies its lock by the bytes, like everything else here" src/runtime/run-lock.ts \
  's/  if \(current\.kind !== "lock" \|\| current\.raw !== held\.raw\) \{/  if (current.kind !== "lock" || current.contents.owner.pid !== held.contents.owner.pid || current.contents.acquiredAt !== held.contents.acquiredAt) {/'

# A lock this user cannot read at all — a run started by another account, since a lock is 0600 —
# arriving as a bare errno and a stack trace.
expect_red "an unreadable lock is explained rather than passed on" src/runtime/run-lock.ts \
  's/    refuseUnreadable\(error, path\);\n    throw error;/    throw error;/'

# The `mkdir` half of the unwritable-repository message, which its own docblock names first and which
# had no test: only the staging write was covered.
expect_red "an unwritable repository is explained from the mkdir too" src/runtime/run-lock.ts \
  's/        refuseUnwritable\(error, dirname\(path\)\);\n        throw error;/        throw error;/'

# The removal of the set-aside file, after the reclamation has already succeeded, turned back into
# something that can throw. A completed reclamation becomes an errno and the run will not start.
expect_red "tidying up cannot turn a reclamation that happened into a failure" src/runtime/run-lock.ts \
  's/    await unlink\(aside\)\.catch\(ignoreCleanupFailure\);\n    return \{ kind: "removed" \};/    await unlink(aside).catch(ignoreMissing);\n    return { kind: "removed" };/'

# Inert leftovers re-read and re-probed on every attempt rather than once per acquisition. A `ps`
# spawn each, on the startup path, for files that will never stop being inert.
expect_red "an inert leftover is judged once per acquisition" src/runtime/run-lock.ts \
  's/    if \(inert\.has\(entry\)\) continue;/    if (false) continue;/'

mutation_gate_finish "each run-lock criterion has a test that fails when it is broken"
