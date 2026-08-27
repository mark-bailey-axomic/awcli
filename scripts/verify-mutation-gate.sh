#!/usr/bin/env bash
# A self-test for the mutation-gate harness.
#
# Every other gate here trusts this harness to break a source file, run a suite, and put the tree
# back exactly as it found it — without touching the developer's own checkout while it does. Nothing
# was checking that it does. Review has now found three real traps in it: backups keyed by basename,
# so two subjects sharing one restored over each other; a substitution count added up across
# mutations, so a half-applied mutation still printed ok; and mutations applied in the shared
# checkout, where anything else reading the tree sees them. A bug of that kind is worse than a bug in
# any single gate: the gates it runs would still print PASS.
#
# So the harness gets the same treatment it gives everything else.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SANDBOX="$(mktemp -d)"
# Set before sourcing the harness on purpose: the harness has to *inherit* this rather than replace
# it, which is the third thing being tested here. It used to replace it, and leaked this directory on
# every run of every gate.
trap 'rm -rf "$SANDBOX"' EXIT

mkdir -p "$SANDBOX/a" "$SANDBOX/b" "$SANDBOX/plain dir"
printf 'contents of a\n' >"$SANDBOX/a/same-name.ts"
printf 'contents of b\n' >"$SANDBOX/b/same-name.ts"
printf 'contents of spaced\n' >"$SANDBOX/plain dir/spaced.ts"

# A tracked file, by relative path, so the isolation check below has something real to break.
WITNESS="README.md"
WITNESS_BEFORE="$(cat "$REPO_ROOT/$WITNESS")"

# shellcheck source=scripts/lib/mutation-gate.sh
source "$REPO_ROOT/scripts/lib/mutation-gate.sh"

# No suite: this exercises the mechanics only, never expect_red, so nothing runs vitest.
mutation_gate_init "" \
  "$SANDBOX/a/same-name.ts" "$SANDBOX/b/same-name.ts" "$SANDBOX/plain dir/spaced.ts" "$WITNESS"

failed=0
report() {
  echo "FAIL: $1" >&2
  failed=1
}

# ── The mutations land in a private copy, not in the checkout ────────────────────────────────
if [[ "$PWD" == "$REPO_ROOT" ]]; then
  report "the harness is working in the repository itself, so every gate mutates the developer's checkout"
fi
printf 'MUTATED witness\n' >"$WITNESS"
if [[ "$(cat "$REPO_ROOT/$WITNESS")" != "$WITNESS_BEFORE" ]]; then
  report "breaking a tracked file changed $REPO_ROOT/$WITNESS — the checkout is not isolated"
fi

# ── Each subject is restored from its own backup ─────────────────────────────────────────────
printf 'MUTATED a\n' >"$SANDBOX/a/same-name.ts"
printf 'MUTATED b\n' >"$SANDBOX/b/same-name.ts"
printf 'MUTATED spaced\n' >"$SANDBOX/plain dir/spaced.ts"

mg_restore

check() {
  local file="$1" expected="$2"
  local actual
  actual="$(cat "$file")"
  if [[ "$actual" != "$expected" ]]; then
    report "$file restored to '$actual', expected '$expected'"
  fi
}
check "$SANDBOX/a/same-name.ts" "contents of a"
check "$SANDBOX/b/same-name.ts" "contents of b"
check "$SANDBOX/plain dir/spaced.ts" "contents of spaced"

# ── A subject that points back into the checkout is refused ──────────────────────────────────
#
# The copy only isolates subjects named relatively; an absolute path into the real tree goes on
# pointing at it, so a gate spelling its subject "$REPO_ROOT/src/foo.ts" would break the developer's
# file and the isolation above would be decoration. Absolute is not itself the problem — this
# self-test's own subjects are absolute paths into a temp sandbox — so the check is about where the
# path leads. In subshells: refusing exits the script, which is the behaviour under test.
if (mg_check_subject "$REPO_ROOT/$WITNESS" >/dev/null 2>&1); then
  report "the harness accepted an absolute subject path into the checkout"
fi
if ! (mg_check_subject "$SANDBOX/a/same-name.ts" >/dev/null 2>&1); then
  report "the harness refused an absolute subject path outside the checkout"
fi
if ! (mg_check_subject "src/runtime/run-lock.ts" >/dev/null 2>&1); then
  report "the harness refused an ordinary relative subject path"
fi

# ── A suite that never ran is not a suite that went red ──────────────────────────────────────
#
# `expect_red` took any non-zero exit as proof that a criterion is checked. vitest exits non-zero
# for a mutation it cannot parse, printing `Tests  no tests` with not one assertion evaluated — so a
# substitution that produced invalid TypeScript reported `ok` for a criterion nothing had looked at.
# Crafted summaries rather than a real run: the predicate is what is under test here, and this
# self-test deliberately never starts vitest.
printf ' Test Files  1 failed (1)\n      Tests  1 failed | 52 passed (53)\n' >"$SANDBOX/red.log"
printf ' Test Files  1 failed (1)\n      Tests  no tests\n' >"$SANDBOX/never-ran.log"
# And a coloured one, with the escape falling between the count and the word so that it cannot match
# by accident. vitest leaves this summary uncoloured when its output is a file, which is how the
# gates run it — so this fixture is not describing what happens today. It is what keeps the
# predicate's ANSI strip from being deleted as unused by someone who checked only the current
# behaviour, and `FORCE_COLOR` in a shell is enough to need it.
printf ' \e[31mTest Files  1 failed (1)\e[39m\n      Tests  \e[31m1\e[39m failed | 52 passed (53)\n' \
  >"$SANDBOX/coloured.log"

if ! mg_suite_reported_failures "$SANDBOX/red.log"; then
  report "a suite that reported a failing test was not recognised as red"
fi
if mg_suite_reported_failures "$SANDBOX/never-ran.log"; then
  report "a suite that never ran a test was accepted as red, so a broken mutation would print ok"
fi
if ! mg_suite_reported_failures "$SANDBOX/coloured.log"; then
  report "a coloured vitest summary was not recognised as red"
fi

# ── A mutation that does not apply exactly once is refused ───────────────────────────────────
#
# In a subshell, because mg_mutate exits the script when it refuses — which is the behaviour under
# test. The three cases are the ones that used to slip through: a pattern that matched nothing, a
# sibling that matched nothing while the first matched, and a `/g` matching twice covering for a
# sibling matching none, which is what an added-up count cannot tell apart from two clean matches.
printf 'alpha\nalpha\nbeta\n' >"$SANDBOX/a/same-name.ts"
expect_refused() {
  local what="$1"
  shift
  if (mg_mutate "self-test: $what" "$SANDBOX/a/same-name.ts" "$@" >/dev/null 2>&1); then
    report "the harness accepted a mutation that $what"
  fi
}
expect_refused "matches nothing" 's/gamma/GAMMA/'
expect_refused "has a sibling matching nothing" 's/beta/BETA/' 's/gamma/GAMMA/'
expect_refused "matches twice under /g" 's/alpha/ALPHA/g'
expect_refused "covers a sibling's zero matches with a /g pair" \
  's/alpha/ALPHA/g' 's/gamma/GAMMA/'

# And one that does apply exactly once is accepted, so the check above is not simply always true.
printf 'alpha\nalpha\nbeta\n' >"$SANDBOX/a/same-name.ts"
if ! (mg_mutate "self-test: applies once" "$SANDBOX/a/same-name.ts" 's/beta/BETA/'); then
  report "the harness refused a mutation that applies exactly once"
fi
if [[ "$(cat "$SANDBOX/a/same-name.ts")" != "alpha
alpha
BETA" ]]; then
  report "the accepted mutation was not applied to the subject"
fi

mg_restore

if ((failed)); then
  echo "FAIL: the mutation-gate harness does not do what every other gate here assumes it does" >&2
  exit 1
fi

echo "PASS: the harness isolates the checkout, keeps subjects out of it, restores each from its own backup, refuses a mutation that does not apply exactly once, and tells a suite that went red from one that never ran"
