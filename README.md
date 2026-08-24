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
> see [`.atelier/tickets/`](.atelier/tickets/) for the 23 tickets and their order.

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

Requires Node >= 20.11. Then, from any directory:

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
| `npm run verify:typecheck-gate` | Prove the typecheck gate rejects a deliberate error |

The last two exist because a claim nobody tests is a claim that stops being true quietly.
`verify:global` is the one that matters: running `node dist/main.js` proves nothing about
whether a *global install* works, and that is this tool's entire premise.

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
| [Tickets](.atelier/tickets/) | 23 tickets, dependency-ordered |

## License

MIT — see [LICENSE](LICENSE).
