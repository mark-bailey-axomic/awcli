#!/usr/bin/env bash
# Prove the contract conformance gate actually fails.
#
# The declaration is the specification and the runtime is checked against it (ADR-0002), but a
# check nobody has watched fail is indistinguishable from one that passes everything. This one
# has been wrong three times: an Exact<> whose failure branch was `never` reported every drifting
# member as no drift at all, because `never extends true` is true; while the sub-APIs used
# method syntax, a runtime narrowing a parameter was accepted for nine of the twelve members; and
# a build with two members drifting at once named neither on the line this script reads, so the
# acceptance criterion held for a single drift and no further.
#
# So there are thirteen cases, one per class of drift the gate claims to catch that a mutation can
# reach. Ten diverge the runtime from the declaration: a top-level member, a member of a sub-API,
# a readonly modifier at each of those two levels, a readonly modifier on a sub-API *function* at
# each of the two sub-APIs whose functions BR-025 and BR-038 lean on, a sub-API member typed
# `any`, a dropped trailing optional parameter, a dropped type-parameter default, and two members
# diverging at once. The last three diverge the declaration instead — a field turned optional
# inside an interface both sides merely name, and the same inside an object type written inline
# inside one, neither of which conformance.ts can reach and the construction fixture is the gate
# for. Each asserts the build rejects the divergence, asserts the rejection comes from the file
# that is supposed to object AND names an offending member on the same line, and always restores.
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
for interface_name in ExecApi GitApi FsApi LogApi EnvApi SchemaApi ContractVersion; do
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

# node rather than sed: these lines contain [], () and |, which sed would read as a regex —
# `readonly string[]` is a bracket expression, not five literal characters. This is a literal
# substring replace, and it exits 3 when the line is not there, so renaming it upstream fails
# loudly instead of leaving a case asserting that a clean tree builds.
diverge() {
  local target="$1" declared="$2" diverged="$3"
  node -e '
    const fs = require("node:fs");
    const [file, from, to] = process.argv.slice(1);
    const source = fs.readFileSync(file, "utf8");
    if (!source.includes(from)) process.exit(3);
    fs.writeFileSync(file, source.replace(from, to));
  ' "$target" "$declared" "$diverged"
}

# $1 the member the build must name · $2 what is being diverged, for messages
# $3 the line as written · $4 the line diverged
# $5 the file to diverge, default the runtime · $6 the file that must object, default conformance
check_case() {
  local named="$1" label="$2" declared="$3" diverged="$4"
  local target="${5:-$RUNTIME}" objector="${6:-$CONFORMANCE}"
  local status=0 output

  restore
  if ! diverge "$target" "$declared" "$diverged"; then
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

# Two divergences at once, which is the case a single-drift assertion cannot speak for. Each check
# collapses to a union of names, and TypeScript resolves a union in a constraint failure only when
# it holds one member — so with two, the error used to lead with the alias and push an offender
# onto an elaboration line carrying no file name, which is not a line this script can read and not
# a line a truncated log keeps. Either name satisfies this: the claim is that a build always names
# an offender, not that it names a particular one, and OneOf picks whichever the mapped type put
# last.
# $1 $2 the two acceptable names · $3 label · $4 $5 first line as written/diverged · $6 $7 second
check_pair() {
  local first="$1" second="$2" label="$3"
  local status=0 output

  restore
  if ! diverge "$RUNTIME" "$4" "$5" || ! diverge "$RUNTIME" "$6" "$7"; then
    echo "FAIL: could not diverge ${label} — this case no longer tests anything" >&2
    exit 1
  fi

  output="$(npm run build --silent 2>&1)" || status=$?

  if [ "$status" -eq 0 ]; then
    echo "FAIL: the build passed with ${label}" >&2
    exit 1
  fi

  if ! printf '%s\n' "$output" | grep -F "$CONFORMANCE" |
    grep -qE "\"(${first}|${second})\""; then
    echo "FAIL: ${label}, but ${CONFORMANCE} named neither '${first}' nor '${second}':" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi

  echo "  ok: ${label} — rejected by ${CONFORMANCE}, naming one of '${first}' / '${second}'"
}

# A top-level member: the parameter type no longer matches.
check_case "exec" "exec" \
  '    command: string | readonly string[],' \
  '    command: number,'

# A member of a sub-API, narrowed rather than changed outright. This is the case that passed
# silently while GitApi used method syntax, so it is the one worth keeping.
check_case "git" "git.commit" \
  '    readonly commit: (message: string) => Promise<Commit>;' \
  '    readonly commit: (message: "feat" | "fix") => Promise<Commit>;'

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

# The same modifier again, on a sub-API *function*. Until the declaration marked every function
# readonly this was not drift at all, so DriftedWithin had only data members to answer about and
# nothing proved it reached further. git.commit is the member that writes to the repository.
check_case "git.commit" "git.commit's readonly modifier" \
  '    readonly commit: (message: string) => Promise<Commit>;' \
  '    commit: (message: string) => Promise<Commit>;'

# And on the function BR-025 and BR-028 actually depend on. A helper anywhere in the workflow's
# module graph that can assign over log.info can silence the audit trail; the declaration says it
# cannot, and this is what holds the runtime to saying the same.
check_case "log.info" "log.info's readonly modifier" \
  '    readonly info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;' \
  '    info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;'

# `any` inside a sub-API. IsAny sits inside Exact, and Exact compares whole members: a shape
# holding an `any` is assignable in both directions to the declared shape, because the `any` is,
# so the top-level check never looked in.
check_case "git.branch" "git.branch typed any" \
  '    readonly branch: () => Promise<string>;' \
  '    readonly branch: any;'

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

# Two at once. Not a new class of drift — a new class of *report*, and the one the acceptance
# criterion turned out not to cover.
check_pair "exec" "fs" "two members drifting at once" \
  '    command: string | readonly string[],' \
  '    command: number,' \
  '  readonly fs: {' \
  '  fs: {'

# The classes that are not the runtime's to get wrong. A field turned optional inside an
# interface the declaration and the runtime both merely name is invisible to conformance.ts, which
# compares that member with itself — and invisible to every object literal in the corpus, because
# one supplying every field compiles whether or not they are required. So these diverge the
# declaration, and the construction fixture's required-key witnesses are what must object.
check_case "stderr" "ExecResult.stderr turned optional" \
  '  readonly stderr: string;' \
  '  readonly stderr?: string;' \
  "$DECLARATION" "$CONSTRUCTION"

# The same class, one layer further in: a member of an object type written inline inside an
# interface. An earlier sweep called itself exhaustive over "all 59 required properties" and had
# only ever swept top-level interface members, so this field was never flipped and nothing
# objected when it was. AgentOptions.output.tag is what BR-007 refuses a run over.
check_case "tag" "AgentOptions.output.tag turned optional" \
  '  output?: { tag: string; schema: Schema<T> } | undefined;' \
  '  output?: { tag?: string; schema: Schema<T> } | undefined;' \
  "$DECLARATION" "$CONSTRUCTION"

# And the same again inside one branch of a union, where the ordinary witness cannot reach:
# RequiredKeys collapses a union's branches together, so `ok` turning optional in one branch is
# answered for by the other branch's `ok`, and `value` beside it inherits that blindness.
check_case "value" "SchemaCheck's accepted branch turning value optional" \
  '  | { readonly ok: true; readonly value: T }' \
  '  | { readonly ok: true; readonly value?: T }' \
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
echo "      modifiers including on a sub-API function, an any, a dropped parameter, a dropped"
echo "      type-parameter default and two members drifting at once — and a declaration turning"
echo "      a shared field optional at the top level, inside an inline object type and inside one"
echo "      branch of a union, naming an offender each time"
