#!/usr/bin/env bash
# A self-test for the mutation-gate harness.
#
# Every other gate here trusts this harness to break a tracked source file, run a suite, and put the
# tree back exactly as it found it. Nothing was checking that it does. Review found a real trap in
# it — backups keyed by basename, so two subjects sharing one would restore over each other — and a
# harness bug of that kind is worse than a bug in any single gate: it would silently corrupt the
# working tree of whoever added the second subject, and the gates it runs would still print PASS.
#
# So the harness gets the same treatment it gives everything else. This exercises backup and restore
# against subjects that share a basename, which is the case that used to be broken.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

mkdir -p "$SANDBOX/a" "$SANDBOX/b" "$SANDBOX/plain dir"
printf 'contents of a\n' >"$SANDBOX/a/same-name.ts"
printf 'contents of b\n' >"$SANDBOX/b/same-name.ts"
printf 'contents of spaced\n' >"$SANDBOX/plain dir/spaced.ts"

# shellcheck source=scripts/lib/mutation-gate.sh
source "$REPO_ROOT/scripts/lib/mutation-gate.sh"

# No suite: this exercises backup and restore only, never expect_red, so nothing runs vitest.
mutation_gate_init "" \
  "$SANDBOX/a/same-name.ts" "$SANDBOX/b/same-name.ts" "$SANDBOX/plain dir/spaced.ts"

# Break all three, in ways that are distinguishable from each other.
printf 'MUTATED a\n' >"$SANDBOX/a/same-name.ts"
printf 'MUTATED b\n' >"$SANDBOX/b/same-name.ts"
printf 'MUTATED spaced\n' >"$SANDBOX/plain dir/spaced.ts"

mg_restore

failed=0
check() {
  local file="$1" expected="$2"
  local actual
  actual="$(cat "$file")"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $file restored to '$actual', expected '$expected'" >&2
    failed=1
  fi
}
check "$SANDBOX/a/same-name.ts" "contents of a"
check "$SANDBOX/b/same-name.ts" "contents of b"
check "$SANDBOX/plain dir/spaced.ts" "contents of spaced"

if ((failed)); then
  echo "FAIL: the mutation-gate harness does not restore what it backed up — every gate that uses it is unreliable" >&2
  exit 1
fi

echo "PASS: the mutation-gate harness restores each subject from its own backup"
