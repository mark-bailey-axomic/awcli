#!/usr/bin/env bash
# Prove the typecheck gate actually fails. A gate nobody has watched fail is not known
# to be a gate: a misconfigured tsconfig, an accidental `// @ts-nocheck`, or a script
# that swallows its exit code all look identical to a passing project.
#
# Introduces a deliberate type error, asserts the gate rejects it, and always restores.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CANARY="src/__typecheck_canary__.ts"
cleanup() { rm -f "$CANARY"; }
trap cleanup EXIT

printf 'export const wrong: number = "not a number";\n' > "$CANARY"

STATUS=0
npm run typecheck --silent >/dev/null 2>&1 || STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  echo "FAIL: typecheck passed with a deliberate type error present — the gate is not a gate" >&2
  exit 1
fi

cleanup
trap - EXIT

STATUS=0
npm run typecheck --silent >/dev/null 2>&1 || STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo "FAIL: typecheck still fails after removing the canary — the tree was already broken" >&2
  exit 1
fi

echo "PASS: typecheck rejects a deliberate type error and accepts the clean tree"
