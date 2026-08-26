#!/usr/bin/env bash
# Prove the run-lock tests are gates. Every criterion on AWCLI-07 is a claim about a decision
# that is easy to get wrong in a way that still passes a happy-path test: a lock that is always
# taken, always reclaimed, or never reclaimed all look fine until the day they matter. AWCLI-00
# shipped a ticked criterion whose check was structurally incapable of failing; this script is
# the answer to that, for this unit.
#
# Each mutation is a plausible wrong implementation, not a syntax error. "Trust the pid" is what
# you get from writing the obvious lock file; "reclaim anything older than an hour" is what a
# reviewer suggests when a stale lock blocks them; "unlink the path" is the release everyone
# writes first. If the suite still passes with one applied, the criterion it belongs to is not
# being checked.
#
# A mutation whose anchor no longer matches fails the script rather than being skipped. A
# refactor that moves this code should therefore break here loudly: a silently skipped mutation
# is exactly the hole this exists to close.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SUITE="test/runtime/run-lock.test.ts test/runtime/run-identity.test.ts"
SUBJECTS=(src/runtime/run-lock.ts src/runtime/run-identity.ts src/runtime/process-probe.ts)

BACKUP_DIR="$(mktemp -d)"
for file in "${SUBJECTS[@]}"; do
  cp "$file" "$BACKUP_DIR/$(basename "$file")"
done

restore() {
  # A loop variable named `subject` here would clobber expect_red's, because bash locals are
  # dynamically scoped and restore is called from inside it.
  for file in "${SUBJECTS[@]}"; do
    cp "$BACKUP_DIR/$(basename "$file")" "$file"
  done
}
cleanup() {
  restore
  rm -rf "$BACKUP_DIR"
}
# INT and TERM as well as EXIT, matching the other gate scripts here: this spends most of its run
# with tracked source files deliberately broken, and an interrupt in that window must not leave
# them that way — on a developer's machine it would look like their own work in progress.
on_signal() {
  cleanup
  trap - EXIT INT TERM
  kill -"$1" $$
}
trap cleanup EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

# Through the package script rather than `npx`, like every other gate here: `npx` will fetch a
# package when the local one is missing, so a broken install would turn this gate into a silent
# download of some other version of vitest.
run_suite() {
  # shellcheck disable=SC2086 # SUITE is deliberately two words: two spec paths.
  npm run test --silent -- $SUITE --testTimeout=5000 >/dev/null 2>&1
}

# expect_red <criterion> <file> <perl-substitution>
expect_red() {
  local criterion="$1" subject="$2" substitution="$3"
  restore
  perl -0pi -e "$substitution" "$subject"
  if cmp -s "$subject" "$BACKUP_DIR/$(basename "$subject")"; then
    echo "FAIL: mutation for '$criterion' changed nothing — its anchor no longer matches $subject." >&2
    echo "      Update the mutation to match the current code; do not delete it." >&2
    exit 1
  fi
  if run_suite; then
    echo "FAIL: the suite passes with '$criterion' broken — that criterion is not being checked" >&2
    exit 1
  fi
  echo "  ok: breaking '$criterion' turns the suite red"
}

# ── Scenario: Two runs of the same name cannot overlap ───────────────────────────────────────
# The lock is taken regardless of who holds it. This is the shape of every lock written without
# a liveness question at all.
expect_red "Two runs of the same name cannot overlap" src/runtime/run-lock.ts \
  's/if \(liveness === "live" && existing !== "unreadable"\)/if (false \&\& existing !== "unreadable")/'

# ── Scenario: Differently named runs may overlap ─────────────────────────────────────────────
# One lock file for the whole repository, which is what you get from treating the lock as a
# property of the repository rather than of the run name.
expect_red "Differently named runs may overlap" src/runtime/run-identity.ts \
  's/return join\(runDirectory\(repositoryPath, runName\), "lock"\);/void runName; return join(runtimeRoot(repositoryPath), "lock");/'

# ── Scenario: A lock left by a killed run is reclaimed automatically ─────────────────────────
# Every existing lock refuses. A correct-looking conservative choice, and the one that makes a
# rebooted machine lose the run name for ever.
expect_red "A lock left by a killed run is reclaimed automatically" src/runtime/run-lock.ts \
  's/if \(liveness === "live" && existing !== "unreadable"\)/if (existing !== "unreadable")/'

# Reclamation happens but says nothing. The lock works; the operator cannot tell a reclaimed run
# from a first one, which BR-035 explicitly forbids.
expect_red "reclamation is reported, never silent" src/runtime/run-lock.ts \
  's/          reclaimed = \{/          reclaimed = undefined ?? {/ ; s/reclaimed = undefined \?\? \{\n            reason,/reclaimed = undefined; void {\n            reason,/'

# ── Scenario: A slow run keeps its lock ──────────────────────────────────────────────────────
# Staleness decided by the lock's age instead of by its owner — the implementation the ticket's
# constraint rules out by name, and the one a reviewer proposes when a stale lock blocks them.
expect_red "A slow run keeps its lock" src/runtime/run-lock.ts \
  's/existing === "unreadable" \? "gone" : livenessOf\(existing\.owner, probe\);/existing === "unreadable" || Date.now() - existing.acquiredAt > 60 * 60 * 1000 ? "gone" : "live";/'

# ── A reused process id does not read as the original owner ──────────────────────────────────
# Trust the pid alone. This is the lock file everyone writes first, and on a busy machine it
# starts reading dead runs as live within minutes.
expect_red "a reused process id does not read as the original owner" src/runtime/process-probe.ts \
  's/return current\.startedAt === owner\.startedAt \? "live" : "different";/void owner; return "live";/'

# The other half of the same criterion: self must be identified the same way as anyone else, or a
# live owner fails to match its own recorded identity and every lock reads as stale.
expect_red "a process's own identity comes from the same source as any other's" src/runtime/process-probe.ts \
  's/const identity = systemProcessProbe\.identify\(process\.pid\);/const identity = { pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000) };/'

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
  's/  const current = await readLock\(held\.path\);\n  if \(current === "absent"\) return;/  const current = await readLock(held.path);\n  if (current === "absent") return;\n  await unlink(held.path).catch(ignoreMissing);\n  if (true) return;/'

# ── An explicit run name is validated, never rewritten ──────────────────────────────────────
# Slugify what the operator typed. Two distinct --name values can then collide on one lock file,
# which is two runs believing they hold different locks.
expect_red "an explicit run name is refused rather than rewritten" src/runtime/run-identity.ts \
  's/    \? defaultRunName\(request\.workflowReference\)\n    : validateRunName\(explicit\);/    ? defaultRunName(request.workflowReference)\n    : defaultRunName(explicit);/'

# ── The derived default is deterministic ────────────────────────────────────────────────────
# A per-invocation suffix. Every run becomes a different writer and BR-010 stops firing at all.
expect_red "the derived run name is deterministic" src/runtime/run-identity.ts \
  's/^  const slug = stem/  let slug = stem/m ; s/  if \(slug\.length === 0\) \{/  slug = (slug + "-" + process.hrtime.bigint()).slice(0, 60);\n  if (slug.length === 0) {/'

# ── A run name may not collide with the layout's own paths ──────────────────────────────────
expect_red "a reserved run name is refused" src/runtime/run-identity.ts \
  's/  if \(RESERVED_RUN_NAMES\.includes\(name\)\) \{/  if (false) {/'

restore
if ! run_suite; then
  echo "FAIL: the suite does not pass on the restored tree — it was already broken" >&2
  exit 1
fi

echo "PASS: each run-lock criterion has a test that fails when it is broken"
