# The frozen v1 workflow corpus

Files compiled against `src/contract/awcli.d.ts` alone, in a directory with no installed
packages, by `test/contract/standalone-declaration.test.ts`.

## Why they exist

`V1_SURFACE_BASELINE` guards top-level member *names*, and `conformance.ts` compares each
member's signature against the runtime's. Neither reaches inside a named interface: both sides
say `AgentOptions`, so comparing them compares a type with itself. Deleting
`AgentOptions.model`, or narrowing `ExecResult.exitCode`, renames nothing and passes both — but
it breaks committed workflows, which is what BR-033 forbids. These files are the committed
workflows.

## What each kind catches

- **`construction.ts`** builds every declared shape as a fresh object literal. A deleted field
  becomes an excess property; a narrowed field no longer accepts the value written here. This is
  the only fixture that catches a narrowing in an *output* position — a workflow that merely
  reads `const n: number = result.exitCode` keeps compiling when `exitCode` becomes `0 | 1`,
  because `0 | 1` is assignable to `number`.
- **The workflow fixtures** (`review-workflow.ts`, `text-agent-workflow.ts`,
  `nested-state-workflow.ts`) read the surface the way an author does. They catch a member or
  field being removed outright, and a narrowing in an *input* position — a parameter they pass a
  value to. They are also exemplars: they are the files an author copies, so an unsafe idiom in
  one spreads.

## The rule

**Do not edit these files to accommodate a contract change.** Editing one to make it compile
again is the same act as deleting the test. A member may be added, and a new fixture may be
added to exercise it; an existing fixture changes only when the major version does.

`../v1-rejected/` is the mirror image: files that must *fail* to compile, checked line by line.
It is excluded from the repository's own `tsconfig.json`, because files that are supposed to
fail to compile would otherwise keep `npm run typecheck` permanently red.
