#!/usr/bin/env bash
# Prove the contract conformance gate actually fails.
#
# The declaration is the specification and the runtime is checked against it (ADR-0002), but a
# check nobody has watched fail is indistinguishable from one that passes everything. This one
# has been wrong twice: an Exact<> whose failure branch was `never` reported every drifting
# member as no drift at all, because `never extends true` is true; and while the sub-APIs used
# method syntax, a runtime narrowing a parameter was accepted for nine of the twelve members.
#
# So there are eight cases, one per class of drift the gate claims to catch that a mutation can
# reach. Seven diverge the runtime from the declaration: a top-level member, a member of a
# sub-API, a readonly modifier at each of those two levels, a sub-API member typed `any`, a
# dropped trailing optional parameter, and a dropped type-parameter default. The eighth diverges
# the declaration instead — a field turned optional inside an interface both sides merely name,
# which conformance.ts cannot reach and the construction fixture is the gate for. Each asserts the
# build rejects the divergence, asserts the rejection comes from the file that is supposed to
# object AND names the offending member on the same line, and always restores.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

RUNTIME="src/runtime/context.ts"
DECLARATION="src/contract/awcli.d.ts"
CONFORMANCE="src/contract/conformance.ts"
CONSTRUCTION="test/fixtures/v1-corpus/construction.ts"

# The gate depends on the runtime restating each function-bearing member structurally. Writing
# `git: GitApi` instead would still compile and still be sound — the object literal is checked
# against the named interface — but Exact<> would compare that member with itself and there
# would be nothing here to perturb. That property disappears one member at a time and silently,
# so it is asserted rather than trusted.
for interface_name in ExecApi GitApi FsApi LogApi SchemaApi ContractVersion; do
  if grep -qE "^[[:space:]]+(readonly[[:space:]]+)?[a-z]+: ${interface_name};" "$RUNTIME"; then
    echo "FAIL: ${RUNTIME} names ${interface_name} instead of restating it — that member's" >&2
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

RUNTIME_BACKUP="$(mktemp)"
DECLARATION_BACKUP="$(mktemp)"
cp "$RUNTIME" "$RUNTIME_BACKUP"
cp "$DECLARATION" "$DECLARATION_BACKUP"
restore() {
  cp "$RUNTIME_BACKUP" "$RUNTIME"
  cp "$DECLARATION_BACKUP" "$DECLARATION"
}
# INT and TERM as well as EXIT: this script spends several full builds with a tracked source file
# deliberately corrupted, and a Ctrl-C in that window would otherwise leave it that way — which
# on a developer's machine looks like their own work in progress.
cleanup() {
  restore
  rm -f "$RUNTIME_BACKUP" "$DECLARATION_BACKUP"
}
trap cleanup EXIT INT TERM

# $1 the member the build must name · $2 what is being diverged, for messages
# $3 the line as written · $4 the line diverged
# $5 the file to diverge, default the runtime · $6 the file that must object, default conformance
check_case() {
  local named="$1" label="$2" declared="$3" diverged="$4"
  local target="${5:-$RUNTIME}" objector="${6:-$CONFORMANCE}"
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
  ' "$target" "$declared" "$diverged"; then
    echo "FAIL: could not diverge ${label} in ${target} — this case no longer tests anything" >&2
    exit 1
  fi

  output="$(npm run build --silent 2>&1)" || status=$?

  if [ "$status" -eq 0 ]; then
    echo "FAIL: the build passed with ${label} diverged from the declaration" >&2
    exit 1
  fi

  # Failing is only half of it, and so is failing somewhere that merely mentions the member: the
  # runtime contains the string "exec" in its own source. The file that is supposed to object must
  # be the one complaining, and it must name the member on that same line.
  if ! printf '%s\n' "$output" | grep -F "$objector" | grep -qF "\"${named}\""; then
    echo "FAIL: ${label} diverged, but ${objector} did not report '${named}':" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi

  echo "  ok: ${label} — rejected by ${objector}, naming '${named}'"
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

# The same modifier one level down, which SameReadonly reached only at the top level until
# DriftedWithin asked it of a sub-API's own members. git.dir is data, so a writable one is a
# working copy path a workflow can reassign.
check_case "git.dir" "git.dir's readonly modifier" \
  '    readonly dir: string;' \
  '    dir: string;'

# `any` inside a sub-API. IsAny sits inside Exact, and Exact compares whole members: a shape
# holding an `any` is assignable in both directions to the declared shape, because the `any` is,
# so the top-level check never looked in.
check_case "git.branch" "git.branch typed any" \
  '    branch: () => Promise<string>;' \
  '    branch: any;'

# A dropped trailing optional parameter — a runtime that ignores the options its declaration
# accepts. Assignability cannot see it in either direction, because a callee may always ignore an
# argument its caller passes; IdenticalTo is what closes it.
check_case "sandbox" "sandbox's optional parameter" \
  '  readonly sandbox: (options?: SandboxOptions) => Promise<Scope<State>>;' \
  '  readonly sandbox: () => Promise<Scope<State>>;'

# A dropped type-parameter default. Relating two generic signatures unifies their type parameters
# and never asks what either would instantiate to alone, so this is invisible to assignability —
# and it is not cosmetic: without the default, ctx.agent({ prompt }) hands back
# AgentResult<unknown> and .output stops being a string.
check_case "agent" "agent's type-parameter default" \
  '  readonly agent: <T = string>(options: AgentOptions<T>) => Promise<AgentResult<T>>;' \
  '  readonly agent: <T>(options: AgentOptions<T>) => Promise<AgentResult<T>>;'

# The one class that is not the runtime's to get wrong. A field turned optional inside an
# interface the declaration and the runtime both merely name is invisible to conformance.ts, which
# compares that member with itself — and invisible to every object literal in the corpus, because
# one supplying every field compiles whether or not they are required. So this case diverges the
# declaration, and the construction fixture's required-key witnesses are what must object.
check_case "stderr" "ExecResult.stderr turned optional" \
  '  readonly stderr: string;' \
  '  readonly stderr?: string;' \
  "$DECLARATION" "$CONSTRUCTION"

cleanup
trap - EXIT INT TERM

STATUS=0
npm run build --silent >/dev/null 2>&1 || STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo "FAIL: the build still fails after restoring the diverged files — the tree was already broken" >&2
  exit 1
fi

echo "PASS: the build rejects a runtime diverging from the declaration — both levels, both"
echo "      modifiers, an any, a dropped parameter and a dropped type-parameter default — and a"
echo "      declaration turning a shared field optional, naming the offender each time"
