# The frozen v1 workflow corpus

Workflows compiled against `src/contract/awcli.d.ts` alone, in a directory with no installed
packages, by `test/contract/standalone-declaration.test.ts`.

They exist because `V1_SURFACE_BASELINE` only guards member *names*. Narrowing
`ExecResult.exitCode` to `0 | 1`, or deleting `Usage.costUsd`, renames nothing and passes
every other gate — but it breaks committed workflows, which is precisely what BR-033
forbids. These files are the committed workflows. A narrowing of anything they touch stops
them compiling.

**Do not edit them to accommodate a contract change.** Editing one to make it compile again
is the same act as deleting the test. A member may be added, and a new fixture may be added
to exercise it; an existing fixture changes only when the major version does.

`../v1-rejected/` is the mirror image: files that must *fail* to compile.

`../v1-rejected/` is excluded from the repository's own `tsconfig.json`. Those files are
supposed to fail to compile, so leaving them in `npm run typecheck` would mean a permanently
red gate. The standalone test compiles them deliberately and requires the failure.
