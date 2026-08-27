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
# it. It used to replace it, and leaked this directory on every run of every gate. Asserted below
# rather than only described — this comment claimed to name "the third thing being tested here" while
# nothing tested it at all, and then pointed at a different section once one was inserted above it.
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

# ── A trap the calling script set first is inherited, not replaced ───────────────────────────
#
# The hook that removes $SANDBOX is the one set above. If the harness replaces the trap instead of
# inheriting it, every gate run leaks a temp directory — silently, with every gate still printing
# PASS. Checked here rather than by inspecting the trap, because what matters is that the command
# survived into the harness's own list.
if [[ " ${MG_EXIT_HOOKS[*]-} " != *"rm -rf \"\$SANDBOX\""* ]]; then
  report "the harness did not inherit the EXIT trap this script set before it was sourced"
fi

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
# And one that reaches the checkout without being spelled like it. A prefix match answers a question
# about spelling; the question is which tree the path leads to.
mkdir -p "$SANDBOX/through"
ln -s "$REPO_ROOT" "$SANDBOX/through/repo"
if (mg_check_subject "$SANDBOX/through/repo/$WITNESS" >/dev/null 2>&1); then
  report "the harness accepted a subject reaching the checkout through a symlink"
fi

# ── A gate that named no suite cannot run one ────────────────────────────────────────────────
#
# MG_SUITE is word-split, so an empty one degrades to every spec in the repository — slower, and
# green or red for reasons unconnected to the mutation. This script and the acquisition gate both
# initialise with no suite on purpose, and both run something other than vitest; the arrangement was
# described in a comment, which is weaker than refusing.
if (mg_run_suite >/dev/null 2>&1); then
  report "the harness ran a suite for a gate that named none, which means every spec in the repo"
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

# ── A red that is nothing but a timeout is not evidence either ────────────────────────────────
#
# The clock is not an assertion. But a mutation that makes one test hang while others fail their
# assertions is honest, so the question is whether a timeout was *all* there was — the first version
# of this check refused any red containing one, and stopped two legitimate mutations dead.
printf ' Test Files  1 failed (1)\n      Tests  1 failed | 52 passed (53)\nError: Test timed out in 5000ms.\n' \
  >"$SANDBOX/timeout-only.log"
printf ' Test Files  1 failed (1)\n      Tests  3 failed | 50 passed (53)\nError: Test timed out in 5000ms.\n' \
  >"$SANDBOX/timeout-and-failures.log"
if ! mg_suite_only_timed_out "$SANDBOX/timeout-only.log"; then
  report "a red whose only failure was a timeout was accepted as evidence"
fi
if mg_suite_only_timed_out "$SANDBOX/timeout-and-failures.log"; then
  report "a red with real failures alongside a timeout was rejected"
fi
if mg_suite_only_timed_out "$SANDBOX/red.log"; then
  report "a red with no timeout at all was treated as a timeout"
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
# A subject that does not exist is the one where perl says nothing and exits 0, so the mutation
# applies to no file and the suite passes *unbroken* — reported as a criterion that is not checked,
# which sends whoever reads it to fix the wrong thing. Reachable from a quoting mistake alone.
if (mg_mutate "self-test: a missing subject" "$SANDBOX/no-such-file.ts" 's/alpha/ALPHA/' >/dev/null 2>&1); then
  report "the harness accepted a mutation whose subject does not exist"
fi

expect_refused "matches nothing" 's/gamma/GAMMA/'
expect_refused "has a sibling matching nothing" 's/beta/BETA/' 's/gamma/GAMMA/'
expect_refused "matches twice under /g" 's/alpha/ALPHA/g'
# Perl interpolates a replacement as a double-quoted string, so `${x}` in one is a symbolic deref and
# silently becomes the empty string. A mutation written that way inserts something other than what it
# says, and still turns a suite red — the exact shape of failure this harness exists to catch.
# Its own reset first: a refused mutation has already written the file by the time perl's END block
# exits, so the subject each of these sees is whatever the one before it left.
printf 'alpha\nalpha\nbeta\n' >"$SANDBOX/a/same-name.ts"
expect_refused "would insert an interpolated replacement" 's/beta/`${beta}`/'
expect_refused "covers a sibling's zero matches with a /g pair" \
  's/alpha/ALPHA/g' 's/gamma/GAMMA/'

# A capture-group backreference is the interpolation that is meant, and one mutation in
# verify-disposal-gate.sh depends on it, so it must not be caught by the rule above.
printf 'alpha\nalpha\nbeta\n' >"$SANDBOX/a/same-name.ts"
if ! (mg_mutate "self-test: keeps a backreference" "$SANDBOX/a/same-name.ts" 's/(beta)/$1$1/'); then
  report "the harness refused a mutation whose replacement uses a capture-group backreference"
fi
if [[ "$(cat "$SANDBOX/a/same-name.ts")" != *"betabeta"* ]]; then
  report "the backreference did not expand"
fi

# And an escaped one is accepted, so the check above is not simply refusing every dollar sign.
printf 'alpha\nalpha\nbeta\n' >"$SANDBOX/a/same-name.ts"
if ! (mg_mutate "self-test: escapes its dollar" "$SANDBOX/a/same-name.ts" 's/beta/`\${beta}`/'); then
  report "the harness refused a mutation whose replacement escapes its dollar sign"
fi
if [[ "$(cat "$SANDBOX/a/same-name.ts")" != *'`${beta}`'* ]]; then
  report "the escaped replacement did not land as written"
fi

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

echo "PASS: the harness isolates the checkout, inherits the caller's EXIT trap, keeps subjects out of the checkout however they are spelled, restores each from its own backup, refuses a mutation whose subject is missing or that does not apply exactly once or that would silently insert an interpolated replacement, refuses to run a suite nobody named, tells a red that is nothing but a timeout from one with real failures, and tells a suite that went red from one that never ran"
