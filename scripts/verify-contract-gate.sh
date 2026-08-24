#!/usr/bin/env bash
# Prove the contract conformance gate actually fails. The declaration is the specification
# and the runtime is checked against it (ADR-0002), but a check nobody has watched fail is
# indistinguishable from one that passes everything. This check has already been wrong twice:
# an Exact<> whose failure branch was `never` reported every drifting member as no drift at
# all, because `never extends true` is true; and while the sub-APIs used method syntax, a
# runtime narrowing a parameter was accepted for nine of the twelve members.
#
# So there are two cases, not one. A top-level member, and a member of a sub-API — the class
# of drift that used to pass. Each diverges one line of the runtime, asserts the build
# rejects it, asserts the rejection comes from the conformance file and names the member, and
# always restores.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TARGET="src/runtime/context.ts"
CONFORMANCE="src/contract/conformance.ts"

# Before diverging anything: a tree that is already failing conformance would print some
# other member's name, and a case asserting only "the build failed and said 'exec'" could be
# satisfied by a drift it did not cause. Establishing the baseline is what makes each case
# attributable to its own perturbation.
STATUS=0
npm run build --silent >/dev/null 2>&1 || STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo "FAIL: the build already fails before anything was diverged — fix the tree first" >&2
  exit 1
fi

BACKUP="$(mktemp)"
cp "$TARGET" "$BACKUP"
restore() { cp "$BACKUP" "$TARGET"; }
trap 'restore; rm -f "$BACKUP"' EXIT

# $1 the member the build must name · $2 what is being diverged, for messages
# $3 the line as written · $4 the line diverged
check_case() {
  local named="$1" label="$2" declared="$3" diverged="$4"
  local status=0 output

  restore
  # '#' as the delimiter: the lines contain '|', '"' and '/' but never '#'.
  sed "s#^${declared}\$#${diverged}#" "$TARGET" > "$TARGET.diverged"
  mv "$TARGET.diverged" "$TARGET"

  # Renaming the line upstream would leave the file untouched and this case asserting that a
  # clean tree builds, which it already knows.
  if ! grep -qF "$diverged" "$TARGET"; then
    echo "FAIL: could not diverge ${label} in ${TARGET} — this case no longer tests anything" >&2
    exit 1
  fi

  output="$(npm run build --silent 2>&1)" || status=$?

  if [ "$status" -eq 0 ]; then
    echo "FAIL: the build passed with ${label} diverged from the declaration" >&2
    exit 1
  fi

  # Failing is only half of it. Requiring the conformance file as well as the member name
  # stops an unrelated failure that happens to quote a line of source from counting: the
  # runtime contains the string "exec" in its own refusals.
  if ! printf '%s\n' "$output" | grep -q "$CONFORMANCE"; then
    echo "FAIL: ${label} diverged, but the failure did not come from ${CONFORMANCE}:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  if ! printf '%s\n' "$output" | grep -q "\"${named}\""; then
    echo "FAIL: the build rejected ${label} without naming '${named}':" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi

  echo "  ok: ${label} — rejected by ${CONFORMANCE}, naming '${named}'"
}

# A top-level member: the parameter type no longer matches.
check_case "exec" "exec" \
  '  exec: (command: string) => Promise<ExecResult>;' \
  '  exec: (command: number) => Promise<ExecResult>;'

# A member of a sub-API, narrowed rather than changed outright. This is the case that passed
# silently while GitApi used method syntax, so it is the one worth keeping.
check_case "git" "git.commit" \
  '    commit: (message: string) => Promise<Commit>;' \
  '    commit: (message: "feat" | "fix") => Promise<Commit>;'

restore
trap - EXIT
rm -f "$BACKUP"

STATUS=0
npm run build --silent >/dev/null 2>&1 || STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo "FAIL: the build still fails after restoring ${TARGET} — the tree was already broken" >&2
  exit 1
fi

echo "PASS: the build rejects a runtime diverging from the declaration, at both levels, by name"
