#!/usr/bin/env bash
# Prove the disposal tests are gates. Every acceptance criterion on WB-2's first half is a
# claim about a failure path — reverse order, continuing past a failure, not leaking, giving
# up on a hung release — and a test for a failure path is the easiest kind to write so that it
# cannot fail. AWCLI-00 shipped a ticked criterion whose check was structurally incapable of
# failing; this script is the answer to that, for this unit.
#
# Each mutation below is a plausible wrong implementation, not a syntax error: forward order is
# what you get from forgetting one call, `break` is what a reviewer would suggest to "fail
# fast", and awaiting the release directly is the version without the bound. If the suite still
# passes with one applied, the criterion it belongs to is not being checked.
#
# A mutation whose anchor no longer matches fails the script rather than being skipped. A
# refactor that moves this code should therefore break here loudly, which is the intent: a
# silently skipped mutation is exactly the hole this exists to close.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SUBJECT="src/runtime/disposal.ts"
SUITE="test/runtime/disposal.test.ts"
BACKUP="$(mktemp)"
cp "$SUBJECT" "$BACKUP"
restore() { cp "$BACKUP" "$SUBJECT"; }
trap 'restore; rm -f "$BACKUP"' EXIT

# A short per-test timeout so the unbounded-wait mutation is caught by vitest quickly rather
# than sitting on the default. The real suite runs in well under a second.
run_suite() {
  npx vitest run "$SUITE" --testTimeout=1500 >/dev/null 2>&1
}

# expect_red <criterion> <perl-substitution>
expect_red() {
  local criterion="$1" substitution="$2"
  restore
  perl -0pi -e "$substitution" "$SUBJECT"
  if cmp -s "$SUBJECT" "$BACKUP"; then
    echo "FAIL: mutation for '$criterion' changed nothing — its anchor no longer matches $SUBJECT." >&2
    echo "      Update the mutation to match the current code; do not delete it." >&2
    exit 1
  fi
  if run_suite; then
    echo "FAIL: the suite passes with '$criterion' broken — that criterion is not being checked" >&2
    exit 1
  fi
  echo "  ok: breaking '$criterion' turns the suite red"
}

expect_red "resources unwind in reverse" \
  's/\[\.\.\.this\.#entries\]\.reverse\(\)/[...this.#entries]/'

expect_red "a failing release does not stop the rest" \
  's/else failures\.push\(failure\);/else { failures.push(failure); break; }/'

expect_red "a leak is reported" \
  's/(leaks\(\): readonly string\[\] \{\n)/$1    return [];\n/'

expect_red "a hung release is abandoned after a bounded wait" \
  's/Promise\.race\(\[attempt, abandonment\]\)/attempt/'

restore
if ! run_suite; then
  echo "FAIL: the suite does not pass on the restored tree — it was already broken" >&2
  exit 1
fi

echo "PASS: each disposal criterion has a test that fails when it is broken"
