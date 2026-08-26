#!/usr/bin/env bash
# Prove the frozen declaration is actually in the published package.
#
# It was not. `files` is ["dist"], tsup has `dts: false`, and nothing copied it, so
# src/contract/awcli.d.ts reached neither the npm tarball nor a global install — while AWCLI-22's
# `awcli init` has to write that exact file into a target repository and can only write one the
# install carries. AWCLI-01's Out of Scope excludes writing it into a target repository; it does
# not excuse publishing an artifact without it.
#
# Packing rather than listing dist/: `npm pack` runs the same `prepare` lifecycle a consumer's
# install runs, so a copy step that works on a developer's machine and not from a clean tree
# fails here. And byte-identity rather than existence, because this file is the specification —
# a copy that differs from the source is a second version of the contract, and which one an
# author reads is then a matter of where they looked.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SOURCE="src/contract/awcli.d.ts"
PACKAGED="package/dist/contract/awcli.d.ts"

TARBALL=""
SANDBOX=""
cleanup() {
  [ -n "$TARBALL" ] && rm -f -- "$TARBALL"
  [ -n "$SANDBOX" ] && rm -rf -- "$SANDBOX"
  return 0
}
trap cleanup EXIT INT TERM

SANDBOX="$(mktemp -d)"
TARBALL="$(npm pack --silent | tail -n 1)"

if ! tar -tzf "$TARBALL" | grep -qx "$PACKAGED"; then
  echo "FAIL: the tarball does not carry ${PACKAGED}" 1>&2
  echo "      awcli init cannot write a declaration the install does not have. Contents:" 1>&2
  tar -tzf "$TARBALL" 1>&2
  exit 1
fi

tar -xzf "$TARBALL" -C "$SANDBOX" "$PACKAGED"

checksum() {
  md5 -q "$1" 2>/dev/null || md5sum "$1" | cut -d" " -f1
}

SOURCE_SUM="$(checksum "$SOURCE")"
EXTRACTED="$SANDBOX/$PACKAGED"
PACKED_SUM="$(checksum "$EXTRACTED")"

if [ "$SOURCE_SUM" != "$PACKED_SUM" ]; then
  echo "FAIL: the packaged declaration is not the source declaration" 1>&2
  echo "      ${SOURCE}: ${SOURCE_SUM}" 1>&2
  echo "      ${PACKAGED}: ${PACKED_SUM}" 1>&2
  diff "$SOURCE" "$EXTRACTED" 1>&2 || true
  exit 1
fi

# The declaration is a script-mode ambient file and stops being one the moment anything gives it
# a top-level import or export. standalone-declaration.test.ts asserts that of the source; this
# asserts it of the copy that actually ships, which is the one an author's editor will load.
if grep -qE "^(import|export)[[:space:]]" "$EXTRACTED"; then
  echo "FAIL: the packaged declaration has a top-level import or export, so it is a module" 1>&2
  echo "      and every name in it is invisible to a workflow that imports nothing" 1>&2
  exit 1
fi

echo "PASS: the tarball carries ${PACKAGED}, byte-identical to ${SOURCE} and still a script"
echo "      (md5 $SOURCE_SUM)"
