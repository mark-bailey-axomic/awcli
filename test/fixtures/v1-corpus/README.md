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

  A literal cannot notice a field that stayed and turned optional, though: supplying every field
  compiles whether or not the declaration still requires them. The sweep for that flips each of
  the declaration's 65 required property signatures to optional in turn — 57 members of an
  interface, and 8 members of an object type written inline inside one — and twelve of the 65 go
  unnoticed by anything in this repository. An earlier sweep reported eight and called itself
  exhaustive; it had swept top-level interface members only and never descended into an inline
  object type, which is where the other four were. The required-key witnesses at the foot of the
  file close all twelve, and they are the only lines there that are not object literals.
- **The workflow fixtures** (`review-workflow.ts`, `text-agent-workflow.ts`,
  `nested-state-workflow.ts`, `env-and-tuple-workflow.ts`) read the surface the way an author
  does. They catch a member or field being removed outright, and a narrowing in an *input*
  position — a parameter they pass a value to. They are also exemplars: they are the files an
  author copies, so an unsafe idiom in one spreads.

  `env-and-tuple-workflow.ts` is the reader for the two members whose shape the contract states
  rather than only their names. `ctx.env` is an accessor, so reading one variable is what a
  fixture can demonstrate and enumerating is not expressible; and tuple state is the only thing
  that notices `DeepReadonly` flattening a tuple, because a flattened one is still read-only and
  every fixture that only writes to state keeps failing exactly as it did.

## The rule

**Do not edit these files to accommodate a contract change.** Editing one to make it compile
again is the same act as deleting the test. A member may be added, and a new fixture may be
added to exercise it; an existing fixture changes only when the major version does.

That rule binds from the moment v1 ships, which is the moment this branch merges. While AWCLI-01
is still open the declaration is not yet frozen — a review that changes the surface changes these
files with it, and the diff is the review's, not a fixture bending to accommodate one.

`../v1-rejected/` is the mirror image: files that must *fail* to compile, checked line by line.
It is excluded from the repository's own `tsconfig.json`, because files that are supposed to
fail to compile would otherwise keep `npm run typecheck` permanently red.
