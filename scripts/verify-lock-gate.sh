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
# first; and the four under "found in review" are the code that was actually here and shipped for
# review before being caught.
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
  "test/runtime/run-lock.test.ts test/runtime/run-identity.test.ts test/runtime/process-probe.test.ts" \
  src/runtime/run-lock.ts src/runtime/run-identity.ts src/runtime/process-probe.ts

# ── Scenario: Two runs of the same name cannot overlap ───────────────────────────────────────
# The lock is taken regardless of who holds it. This is the shape of every lock written without a
# liveness question at all.
expect_red "Two runs of the same name cannot overlap" src/runtime/run-lock.ts \
  's/if \(existing !== "unreadable" && liveness === "live"\)/if (false \&\& liveness === "live")/'

# ── Scenario: Differently named runs may overlap ─────────────────────────────────────────────
# One lock file for the whole repository, which is what you get from treating the lock as a
# property of the repository rather than of the run name.
expect_red "Differently named runs may overlap" src/runtime/run-identity.ts \
  's/return join\(runDirectory\(repositoryPath, runName\), "lock"\);/void runName; return join(runtimeRoot(repositoryPath), "lock");/'

# ── Scenario: A lock left by a killed run is reclaimed automatically ─────────────────────────
# Every existing lock refuses. A correct-looking conservative choice, and the one that makes a
# rebooted machine lose the run name for ever.
expect_red "A lock left by a killed run is reclaimed automatically" src/runtime/run-lock.ts \
  's/if \(existing !== "unreadable" && liveness === "live"\)/if (existing !== "unreadable")/'

# Reclamation happens but says nothing. The lock works; the operator cannot tell a reclaimed run
# from a first one, which BR-035 explicitly forbids.
expect_red "reclamation is reported, never silent" src/runtime/run-lock.ts \
  's/          reclaimed = \{\n            reason,/          reclaimed = undefined; void {\n            reason,/'

# ── Scenario: A slow run keeps its lock ──────────────────────────────────────────────────────
# Staleness decided by the lock's age instead of by its owner — the implementation the ticket's
# constraint rules out by name, and the one a reviewer proposes when a stale lock blocks them.
expect_red "A slow run keeps its lock" src/runtime/run-lock.ts \
  's/              : await livenessOf\(existing\.owner, probe\);/              : Date.now() - existing.acquiredAt > 60 * 60 * 1000 ? "gone" : "live";/'

# ── A reused process id does not read as the original owner ──────────────────────────────────
# Trust the pid alone. This is the lock file everyone writes first, and on a busy machine it starts
# reading dead runs as live within minutes.
expect_red "a reused process id does not read as the original owner" src/runtime/process-probe.ts \
  's/return answer\.identity\.startedAt === owner\.startedAt \? "live" : "different";/void owner; return "live";/'

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
  's/  const current = await readLock\(held\.path\);\n  if \(current === "absent"\) return;/  const current = await readLock(held.path);\n  if (current === "absent") return;\n  await unlink(held.path).catch(ignoreMissing);\n  if (current) return;/'

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
expect_red "reclaiming removes only the file it judged stale" src/runtime/run-lock.ts \
  's/  const taken = await identifyFile\(aside\);\n  if \(taken !== undefined && taken\.dev === judged\.dev && taken\.ino === judged\.ino\) \{/  const taken = await identifyFile(aside);\n  void judged;\n  if (taken !== undefined) {/'

# An unanswerable probe read as "the owner is gone". A `ps` that timed out on a loaded box, an
# EAGAIN from fork, or `ps` missing from a container image all evicted a live owner's lock — and
# load-correlated, so it fired exactly when a second run was there to collide with.
expect_red "a probe that cannot answer does not read as a dead process" src/runtime/process-probe.ts \
  's/  if \(answer\.kind === "unknown"\) return "undecidable";/  if (answer.kind === "unknown") return "gone";/'

# Another machine's pid judged against this machine's process table. Reclaimed a synced-checkout
# lock and told the operator its owner "was killed", which was false.
expect_red "a lock from another machine is not judged by local pids" src/runtime/run-lock.ts \
  's/            : existing\.host !== contents\.host/            : false/'

# The `continue` that jumped the attempt bound. A dangling symlink at the lock path answers EEXIST
# to `link` and ENOENT to `readFile` at once, so awcli spun at startup burning a core. Both halves
# are mutated: without the symlink refusal the loop bound is what has to stop it.
expect_red "the acquisition loop is bounded on every path" src/runtime/run-lock.ts \
  's/  if \(stats\.isSymbolicLink\(\)\) \{/  if (false) {/' \
  's/      for \(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt\+\+\) \{/      for (let attempt = 1; ; attempt++) {/'

mutation_gate_finish "each run-lock criterion has a test that fails when it is broken"
