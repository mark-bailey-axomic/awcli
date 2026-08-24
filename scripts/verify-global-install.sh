#!/usr/bin/env bash
# Verify the premise of the tool: awcli works from a GLOBAL install, invoked from a
# directory that has nothing to do with the source tree and contains no node_modules.
#
# Deliberately not `npm link` and not `node dist/main.js`. Both pass while a real global
# install is broken — wrong bin path, missing shebang, a file left out of the published
# set, or a runtime import that only resolves inside the repo.
#
# Two things this script must not do, both learned by getting them wrong:
#   1. Build before packing. `npm pack` has to exercise the same lifecycle a consumer
#      gets, so a missing `prepare` script fails here instead of on their machine.
#   2. Install into the real global prefix. A leftover awcli from an earlier run makes
#      `command -v` resolve to a stale binary and the check passes against the wrong
#      thing entirely. Everything goes into a throwaway prefix instead.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TARBALL=""
SANDBOX=""
cleanup() {
  [ -n "$TARBALL" ] && rm -f "$REPO_ROOT/$TARBALL"
  [ -n "$SANDBOX" ] && rm -rf "$SANDBOX"
  return 0
}
trap cleanup EXIT

EXPECTED="$(node -p "require('./package.json').version")"
SANDBOX="$(mktemp -d)"

echo "==> packing (prepare must produce dist/)"
TARBALL="$(npm pack --silent | tail -n 1)"

if ! tar -tzf "$REPO_ROOT/$TARBALL" | grep -q 'package/dist/main\.js'; then
  echo "FAIL: tarball has no dist/main.js — bin would point at a file that does not exist" >&2
  echo "      contents:" >&2
  tar -tzf "$REPO_ROOT/$TARBALL" >&2
  exit 1
fi

PREFIX="$SANDBOX/prefix"
echo "==> installing into a throwaway prefix"
npm install -g --prefix "$PREFIX" "$REPO_ROOT/$TARBALL" --silent

BIN="$PREFIX/bin/awcli"
if [ ! -x "$BIN" ]; then
  echo "FAIL: no executable at $BIN after a global install" >&2
  ls -la "$PREFIX/bin" 2>/dev/null >&2 || echo "      no bin directory was created at all" >&2
  exit 1
fi

# PATH resolution is part of the claim, so check it — against a PATH holding only this
# install, so a stale global awcli can never answer in its place.
WORK="$SANDBOX/unrelated"
mkdir -p "$WORK"
RESOLVED="$(cd "$WORK" && PATH="$PREFIX/bin:$PATH" command -v awcli)"
if [ "$RESOLVED" != "$BIN" ]; then
  echo "FAIL: PATH resolved awcli to '$RESOLVED', expected '$BIN'" >&2
  exit 1
fi

# `|| STATUS=$?` on the assignment: a bare assignment aborts under `set -e`, which would
# make every diagnostic below unreachable — the one failure this script exists to report.
STATUS=0
ACTUAL="$(cd "$WORK" && PATH="$PREFIX/bin:$PATH" awcli --version)" || STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  echo "FAIL: awcli --version exited $STATUS, expected 0" >&2
  echo "      output: ${ACTUAL:-<none>}" >&2
  exit 1
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "FAIL: reported version '$ACTUAL', manifest says '$EXPECTED'" >&2
  exit 1
fi

echo "PASS: reports $ACTUAL, exits 0"
echo "      binary:   $BIN"
echo "      run from: $WORK (no package.json, no node_modules)"
