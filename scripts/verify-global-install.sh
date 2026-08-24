#!/usr/bin/env bash
# Verify the premise of the tool: awcli works from a GLOBAL install, invoked from a
# directory that has nothing to do with the source tree and contains no node_modules.
#
# This is deliberately not `npm link` and not `node dist/main.js`. Both of those pass
# while a real global install is broken — wrong bin path, missing shebang, a file left
# out of the published set, or a runtime import that only resolves inside the repo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

EXPECTED="$(node -p "require('./package.json').version")"
echo "==> building"
npm run build --silent

echo "==> packing"
TARBALL="$(npm pack --silent | tail -n 1)"
trap 'rm -f "$REPO_ROOT/$TARBALL"' EXIT

echo "==> installing globally from $TARBALL"
npm install -g "$REPO_ROOT/$TARBALL" --silent

if ! command -v awcli >/dev/null 2>&1; then
  echo "FAIL: awcli is not on PATH after a global install" >&2
  echo "      npm global bin: $(npm bin -g 2>/dev/null || npm config get prefix)/bin" >&2
  exit 1
fi

# An unrelated directory: no package.json, no node_modules, not under the source tree.
SANDBOX="$(mktemp -d)"
trap 'rm -f "$REPO_ROOT/$TARBALL"; rm -rf "$SANDBOX"' EXIT

echo "==> running from $SANDBOX"
ACTUAL="$(cd "$SANDBOX" && awcli --version)"
STATUS=0
(cd "$SANDBOX" && awcli --version >/dev/null) || STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  echo "FAIL: awcli --version exited $STATUS, expected 0" >&2
  exit 1
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "FAIL: reported version '$ACTUAL', manifest says '$EXPECTED'" >&2
  exit 1
fi

echo "PASS: global install reports $ACTUAL and exits 0, run from $SANDBOX"
echo "      binary: $(command -v awcli)"
