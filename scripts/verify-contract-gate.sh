#!/usr/bin/env bash
# Prove the contract conformance gate actually fails.
#
# The declaration is the specification and the runtime is checked against it (ADR-0002), but a
# check nobody has watched fail is indistinguishable from one that passes everything. This one
# has been wrong twice: an Exact<> whose failure branch was `never` reported every drifting
# member as no drift at all, because `never extends true` is true; and while the sub-APIs used
# method syntax, a runtime narrowing a parameter was accepted for nine of the twelve members.
#
# So there are three cases. A top-level member, a member of a sub-API — the class of drift that
# used to pass — and a readonly modifier, which no amount of assignability checking can see. Each
# diverges one line of the runtime, asserts the build rejects it, asserts the rejection comes from
# the conformance file AND names the member on the same line, and always restores.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TARGET="src/runtime/context.ts"
CONFORMANCE="src/contract/conformance.ts"

# The gate depends on the runtime restating each function-bearing member structurally. Writing
# `git: GitApi` instead would still compile and still be sound — the object literal is checked
# against the named interface — but Exact<> would compare that member with itself and there
# would be nothing here to perturb. That property disappears one member at a time and silently,
# so it is asserted rather than trusted.
for interface_name in ExecApi GitApi FsApi LogApi SchemaApi ContractVersion; do
  if grep -qE "^[[:space:]]+(readonly[[:space:]]+)?[a-z]+: ${interface_name};" "$TARGET"; then
    echo "FAIL: ${TARGET} names ${interface_name} instead of restating it — that member's" >&2
    echo "      conformance check is now a tautology and this script cannot perturb it" >&2
    exit 1
  fi
done

# Before diverging anything: a tree that is already failing conformance would print some other
# member's name, and a case asserting only "the build failed and said 'exec'" could be satisfied
# by a drift it did not cause. Establishing the baseline is what makes each case attributable.
STATUS=0
npm run build --silent >/dev/null 2>&1 || STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo "FAIL: the build already fails before anything was diverged — fix the tree first" >&2
  exit 1
fi

BACKUP="$(mktemp)"
cp "$TARGET" "$BACKUP"
restore() { cp "$BACKUP" "$TARGET"; }
# INT and TERM as well as EXIT: this script spends two full builds with a tracked source file
# deliberately corrupted, and a Ctrl-C in that window would otherwise leave it that way — which
# on a developer's machine looks like their own work in progress.
cleanup() { restore; rm -f "$BACKUP"; }
trap cleanup EXIT INT TERM

# $1 the member the build must name · $2 what is being diverged, for messages
# $3 the line as written · $4 the line diverged
check_case() {
  local named="$1" label="$2" declared="$3" diverged="$4"
  local status=0 output

  restore
  # node rather than sed: these lines contain [], () and |, which sed would read as a regex —
  # `readonly string[]` is a bracket expression, not five literal characters. This is a literal
  # substring replace, and it exits 3 when the line is not there, so renaming it upstream fails
  # loudly instead of leaving this case asserting that a clean tree builds.
  if ! node -e '
    const fs = require("node:fs");
    const [file, from, to] = process.argv.slice(1);
    const source = fs.readFileSync(file, "utf8");
    if (!source.includes(from)) process.exit(3);
    fs.writeFileSync(file, source.replace(from, to));
  ' "$TARGET" "$declared" "$diverged"; then
    echo "FAIL: could not diverge ${label} in ${TARGET} — this case no longer tests anything" >&2
    exit 1
  fi

  output="$(npm run build --silent 2>&1)" || status=$?

  if [ "$status" -eq 0 ]; then
    echo "FAIL: the build passed with ${label} diverged from the declaration" >&2
    exit 1
  fi

  # Failing is only half of it, and so is failing somewhere that merely mentions the member: the
  # runtime contains the string "exec" in its own source. The conformance file must be the one
  # complaining, and it must name the member on that same line.
  if ! printf '%s\n' "$output" | grep -F "$CONFORMANCE" | grep -qF "\"${named}\""; then
    echo "FAIL: ${label} diverged, but ${CONFORMANCE} did not report '${named}':" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi

  echo "  ok: ${label} — rejected by ${CONFORMANCE}, naming '${named}'"
}

# A top-level member: the parameter type no longer matches.
check_case "exec" "exec" \
  '    command: string | readonly string[],' \
  '    command: number,'

# A member of a sub-API, narrowed rather than changed outright. This is the case that passed
# silently while GitApi used method syntax, so it is the one worth keeping.
check_case "git" "git.commit" \
  '    commit: (message: string) => Promise<Commit>;' \
  '    commit: (message: "feat" | "fix") => Promise<Commit>;'

# The readonly modifier. Exact<> cannot see one — TypeScript ignores readonly when it relates two
# types, so a runtime handing out a writable member satisfies a declaration promising a readonly
# one, in both directions. SameReadonly is what closes that, and this is the case that proves it.
check_case "exec" "exec's readonly modifier" \
  '  readonly exec: (' \
  '  exec: ('

cleanup
trap - EXIT INT TERM

STATUS=0
npm run build --silent >/dev/null 2>&1 || STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo "FAIL: the build still fails after restoring ${TARGET} — the tree was already broken" >&2
  exit 1
fi

echo "PASS: the build rejects a runtime diverging from the declaration — both levels and a"
echo "      modifier — and names the member each time"
