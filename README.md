# awcli

Run TypeScript agentic workflows from a **global install**.

A workflow is a TypeScript file with a default export. awcli imports it, calls that export
once per iteration, and passes in a context object carrying everything the workflow needs —
agents, sandboxes, state that survives across iterations, and the project's own facts. The
workflow imports nothing.

That is the difference from tools you add to each project: the repository you point awcli at
needs no `package.json`, no `node_modules`, and no TypeScript toolchain of its own. It can be
a Python or Go repository. One workflow file runs against all of them.

> **Status: early.** `AWCLI-00` is complete — the project builds, tests, type-checks and
> installs globally. No workflow commands exist yet. The design is finished and ticketed:
> see [`.atelier/tickets/`](.atelier/tickets/) for the tickets and their order.

## Install

```bash
git clone https://github.com/mark-bailey-axomic/awcli.git
cd awcli
npm install          # installs devDependencies; `prepare` builds dist/
npm install -g .     # packs and installs the built package globally
```

Both steps are needed. `npm install -g .` on a bare clone fails: npm does not install
devDependencies for a local folder install, so the `prepare` build has no bundler to run.
It fails loudly rather than installing a broken command.

Requires Node >= 20.11 and git >= 2.22. The git floor is `git branch --show-current`, which
awcli uses to read the branch of a live checkout and which arrived in 2.22; `git worktree add`
is older than that. Then, from any directory:

```bash
awcli --version
```

## Development

```bash
npm install     # `prepare` builds dist/ automatically
npm run check   # format:check + typecheck + test + build
```

| Script | What it does |
|---|---|
| `npm run build` | Bundle to `dist/` with tsup |
| `npm run test` | Run the suite with vitest |
| `npm run typecheck` | Strict `tsc --noEmit` |
| `npm run format` / `format:check` | Prettier |
| `npm run verify:global` | Pack, install into a throwaway prefix, run from an unrelated directory |
| `npm run check:gates` | Every gate below, in order. This is what CI runs |

The `verify:*` scripts exist because a claim nobody tests is a claim that stops being true quietly,
and they come in two kinds. `verify:global` is the one that matters most: running `node dist/main.js`
proves nothing about whether a *global install* works, and that is this tool's entire premise.

The rest prove that the suite is a suite. Each takes a claim the tests make, breaks the code the
claim is about, and fails if the tests still pass — so a test that cannot fail is caught rather than
counted. `npm run check:gates` runs all of them and takes long enough to be a job of its own rather than part
of `npm run check` — the mutation gates dominate it, and each of those runs the whole suite once per
mutation. No duration here for the same reason there are no counts below: it is a number that moves
with the code and is quietly wrong the moment it does.

| Gate | Breaks | Expects |
|---|---|---|
| `verify:typecheck-gate` | a deliberate type error | the typecheck to reject it |
| `verify:contract-gate` | the runtime, away from its declaration | the build to reject it |
| `verify:packaged-declaration` | — | the tarball to carry the declaration, byte-identical |
| `verify:spec-invariants` | — | the rules, feature file, manifest and ticket README to agree |
| `verify:disposal-gate` | each disposal guarantee, one at a time | the suite to go red for each |
| `verify:lock-gate` | each run-lock guarantee, one at a time | the suite to go red for each |
| `verify:workspace-gate` | each worktree-provisioning guarantee, one at a time | the suite to go red for each |
| `verify:acquisition-returns` | the backoff timer, as a plain node process | the acquisition to stop returning |
| `verify:mutation-gate` | the harness the three gates above share | its own self-test to catch it |

No counts here on purpose: the number of mutations changes with the code, and a number in prose is
one more thing to be quietly wrong.

## Platforms

macOS, Linux, and Windows via **WSL2**. Native win32 is not supported — see
[ADR-0007](docs/adr/0007-wsl2-is-the-windows-path.md) for why, and note that Docker Desktop's
default backend is already WSL2, so the container path is the same one.

## Design

The design is complete and written down before the code:

| Document | What it holds |
|---|---|
| [Technical design](.atelier/design/agentic-workflow-cli-tdd.md) | Architecture, contracts, work breakdown |
| [Business rules](.atelier/design/agentic-workflow-cli-rules.md) | 37 approved rules |
| [BDD scenarios](.atelier/design/agentic-workflow-cli-bdd.feature) | 60 scenarios, every rule tagged |
| [ADRs](docs/adr/) | Seven decisions and their rationale |
| [Tickets](.atelier/tickets/) | Dependency-ordered; [their README](.atelier/tickets/README.md) carries the totals |

## License

MIT — see [LICENSE](LICENSE).
