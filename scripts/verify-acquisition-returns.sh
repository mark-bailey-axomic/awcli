#!/usr/bin/env bash
# Prove that taking a run lock returns, in a process with nothing else keeping the event loop alive.
#
# This is the one gate here that cannot be a vitest mutation, and the reason is the defect it exists
# for. The backoff between acquisition attempts was written with `timer.unref()`, copied from
# disposal.ts where it is correct. Here it is not: the acquisition is *waiting on* that timer, and an
# unreferenced timer with nothing else pending lets node conclude the event loop is empty and exit.
# `acquireRunLock` then reclaimed a stale lock and never returned — no lock, no refusal, no error,
# exit 13 on an unsettled await. Every test passed, and would have kept passing, because vitest holds
# the loop open for them. Only a plain node process can see it.
#
# So: bundle the fixture with the project's own bundler, run it, and require the RETURNED line. Then
# put the `unref` back, run it again, and require the line to be *missing*. A check nobody has
# watched fail is not known to be a check — and this one had to be watched fail from outside the
# suite entirely.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=scripts/lib/mutation-gate.sh
source "$REPO_ROOT/scripts/lib/mutation-gate.sh"

SUBJECT="src/runtime/run-lock.ts"
FIXTURE="scripts/fixtures/acquisition-returns.ts"

# No suite: this gate runs a node process rather than vitest, so it uses the harness for what it is
# good for — a private copy of the tree, a backup of the subject, restoration on every exit path,
# and a mutation that has to apply exactly once — and does the running itself.
mutation_gate_init "" "$SUBJECT"

TSUP="$PWD/node_modules/.bin/tsup"
# The pinned bundler or nothing. `npx` would fetch some other version of tsup when the install is
# broken, which would turn this gate into a silent download.
if [[ ! -x "$TSUP" ]]; then
  echo "FAIL: tsup is not installed; run npm ci" >&2
  exit 1
fi

WORK="$PWD/.gate-acquisition"
mkdir -p "$WORK"

# Prints whatever the fixture printed, and never fails the script itself: a mutated build is
# *supposed* to fail, and the interesting evidence is the output either way.
run_fixture() {
  local label="$1"
  local repository="$WORK/repo-$label"
  mkdir -p "$repository"
  if ! "$TSUP" "$FIXTURE" \
    --out-dir "$WORK/bundle" --format esm --platform node --target node20 --no-config \
    >"$WORK/build-$label.log" 2>&1; then
    echo "FAIL: could not bundle $FIXTURE" >&2
    cat "$WORK/build-$label.log" >&2
    exit 1
  fi
  node "$WORK/bundle/acquisition-returns.js" "$repository" 2>&1 || true
}

as_written="$(run_fixture as-written)"
if [[ "$as_written" != *"RETURNED: took the lock"* ]]; then
  echo "FAIL: acquireRunLock did not return from a plain node process." >&2
  echo "      Something in the acquisition is waiting on a resource that does not hold the event" >&2
  echo "      loop open, so node exits before the answer arrives. Output was:" >&2
  echo "$as_written" >&2
  exit 1
fi
echo "  ok: the acquisition returns from a process with nothing else pending"

mg_mutate "the backoff between attempts keeps the event loop alive" "$SUBJECT" \
  's/  return sleep\(ms\);/  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref(); });/'

mutated="$(run_fixture unref)"
mg_restore
if [[ "$mutated" == *"RETURNED: took the lock"* ]]; then
  echo "FAIL: the check passes with the backoff timer unreferenced, so it is not a gate." >&2
  exit 1
fi
echo "  ok: unreferencing the backoff timer stops the acquisition from returning"

echo "PASS: taking a run lock returns from a plain node process, and this check can see when it does not"
