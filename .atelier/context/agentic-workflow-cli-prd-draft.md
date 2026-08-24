---
feature: agentic-workflow-cli
status: DRAFT
date: 2026-08-24
source: .atelier/context/agentic-workflow-cli-grill-brief.md
---

# awcli — Agentic Workflow CLI (PRD Draft)

## Problem Statement

Orchestrating AI coding agents across repos today means writing a script that imports an
orchestration library — which requires installing that library into every repo it runs against.
Sandcastle is the reference case: you write `.sandcastle/main.mts`, `import { run } from
"@ai-hero/sandcastle"`, and execute it with `tsx`. That model forces every target repo to be a Node
project with a `package.json`, a lockfile entry, and a `node_modules`, and it means the same
workflow cannot be reused across repos without copying it into each one.

awcli inverts the dependency. A workflow is a TypeScript file that default-exports
`async function workflow(ctx)`. A globally-installed CLI dynamically imports the file and invokes
that function, **injecting** the API as an argument rather than being imported by it. Nothing is
installed into the target repo. Because target repos may not be Node projects at all — and therefore
have no `node_modules` and no `@types/node` — a workflow cannot reliably import anything, so `ctx`
becomes the entire API surface: agents, sandboxes, git, durable state, shell, filesystem, logging,
schema validation, and a per-repo project profile.

Two properties follow, and they are the product:

1. **Point it anywhere.** A workflow written once in a global library can be aimed at any checkout,
   in any language. The per-repo profile (`.awcli/config.json`) is the seam that lets a portable
   workflow learn a repo's test command, standards, and defaults.
2. **Loops that survive.** The CLI owns iteration and persists `ctx.state` to disk, so a multi-hour
   unattended run that dies resumes where it stopped instead of restarting from zero.

## Target Users / Personas

| Persona | Who | Needs | Priority |
|---|---|---|---|
| **Primary — the author** | Solo developer running agentic loops across several repos, some not Node projects | Write a workflow once, aim it at any repo, leave it running unattended, resume after a crash | P0 |
| **Secondary — a colleague** | Teammate who installs awcli globally and runs shared workflows against team repos, *if it proves useful* | A stable `ctx` contract, a clear version-mismatch error, workflows reviewable in git | P1 |
| **Non-user (explicit)** | Public OSS consumer / contributor | Multi-agent support, Windows, docs site, contribution surface | Out of scope |

Audience is personal-first with a plausible near-future team path. That shapes rigor: `ctx` stability
and a legible version gate matter (a colleague will hit them first); a docs site, contribution
guides, and cross-platform support do not.

## User Stories

**Create and run**
- **Given** a repo in any language, **when** I run `awcli create triage`, **then** a TypeScript
  workflow is scaffolded in my global library with types available in my editor and no files added
  to the repo except a generated `.awcli/` directory.
- **Given** a scaffolded workflow, **when** I run `awcli run triage --repo ~/work/api`, **then** the
  CLI imports the file, invokes the default export once with `ctx`, and exits non-zero with a clear
  message if the file has no default export or it is not a function.

**Loop and resume**
- **Given** a workflow and `--iterations 10`, **when** iteration 4 crashes, **then** re-running
  resumes from iteration 5 with `ctx.state` as it stood at the end of iteration 3.
- **Given** a workflow that has finished its work, **when** it returns `{ done: true }`, **then** the
  loop stops early and the exit code distinguishes "completed" from "hit the iteration cap".

**Agents**
- **Given** a workflow calling `ctx.agent({ prompt })`, **when** it runs, **then** Claude Code is
  spawned as a subprocess, its commits are read from git, its tagged output from text, and an idle
  agent is timed out rather than hanging forever.
- **Given** `ctx.agent({ output: { tag: "plan", schema } })`, **when** the agent emits a malformed
  block, **then** awcli makes a narrow re-ask call ("change nothing, emit only a corrected block"),
  bounded, before failing the iteration with the validation detail — the agent's commits are already
  in the worktree either way.

**Isolation**
- **Given** no sandbox requested, **when** an agent runs, **then** it works in a fresh git worktree
  on its own branch — never the live working tree — so uncommitted work is never at risk.
- **Given** `ctx.sandbox({ ... })`, **when** an agent runs, **then** it executes inside a container
  built from the repo's generated `.awcli/Dockerfile`, with host agent credentials mounted read-only
  and never baked into an image layer.
- **Given** a workflow that fans out two agents concurrently, **when** they run, **then** each gets
  its own worktree and container and neither sees the other's changes.

- **Given** a target directory that is not a git repository, **when** I run a workflow against it,
  **then** awcli refuses with a message suggesting `git init`, rather than silently running without
  isolation.
- **Given** a resumed run, **when** it starts, **then** it reports the worktree's HEAD and any
  uncommitted files inherited from the iteration that died.
- **Given** a fan-out branch that tries to write `ctx.state`, **when** it does, **then** it throws
  immediately naming the correct pattern, instead of silently losing the update.

**Safety rails**
- **Given** a run already in flight under the same name, **when** I start another, **then** it fails
  fast naming the held lock rather than silently sharing state and worktrees.
- **Given** a repo whose config requires a newer awcli, **when** I run a workflow, **then** it
  refuses to start and names the required version — instead of failing later on a missing `ctx`
  method.
- **Given** a run I interrupt with Ctrl-C, **when** it exits, **then** agent subprocesses are killed
  and containers removed, worktrees are preserved for inspection, and the lock is released.

## Feature Requirements

### P0 — v1 (thin slice **plus** containers; all thirteen architecture decisions realized)

| ID | Requirement |
|---|---|
| P0-1 | **Workflow runner.** Dynamic import of a `.ts` file via a bundled `tsx`, ignoring the project `tsconfig.json`. Validate the default export is a function; invoke with `ctx`. |
| P0-2 | **CLI-owned loop with durable state.** `--iterations N` plus `--max-duration`, a wall-clock ceiling that needs no usage parsing and so cannot silently degrade; a workflow declaring itself done awaits agents still in flight so their commits land intact, and declares at its top level whether exhausting a limit counts as finished (default: incomplete); `ctx.state` hydrated at entry and **written through on mutation** (debounced, temp-file-plus-rename atomic), with `ctx.state.save()` as an explicit flush. Named runs key the state file. Opt-in state schema via `ctx.schema` validated on hydrate; mismatch fails at startup and suggests `--reset-state`. |
| P0-3 | **`ctx` v1 surface.** `agent`, `sandbox`, `state`, `args`, `project`, `exec`, `fs`, `log`, `git`, `env`, `schema`. `schema` is non-optional (P0-5 and P0-2 depend on it). Child contexts passed into agent/sandbox scopes expose `ctx.state` **frozen** — a write throws immediately, making single-writer structural. |
| P0-4 | **Claude Code driver, git-and-text truth.** Spawn the agent as a subprocess. Commits from `git log base..HEAD` in the worktree; tagged output and completion signals from plain text scanning; idle and completion timeouts from any output at all. `stream-json` is parsed **opportunistically** for usage and tool-call visibility, every field degrading to undefined rather than throwing. An unrecognized stream format emits **one** warning rather than degrading in silence. Behind a driver interface other CLIs can implement later. |
| P0-5 | **Structured output.** `output: { tag, schema }` extraction and validation, with a bounded **scoped re-ask** on invalid ("change nothing, emit only a corrected block") — no dependency on agent session storage. Startup check that the prompt asks for the tag. |
| P0-6 | **Worktree isolation.** A git worktree on its own branch per sandbox/agent under `.awcli/run/worktrees/`; creation, locking, reuse-by-default, `--fresh`, cleanup. No auto-merge. A run **owns its worktree and its state as one resumable unit**; awcli records HEAD and dirty status so resume reports inherited uncommitted work. Branches are named deterministically from run plus slot, so a resume reattaches the branch it already had, and are **never auto-deleted** — the agent's commits are the deliverable. Non-git target directories are refused with a message suggesting `git init`. The default non-container path is named **worktree** everywhere — API, `--help`, docs, log output; `ctx.sandbox()` means container, full stop. |
| P0-7 | **Container sandbox, no published image.** Generated `.awcli/Dockerfile` installing git and the agent CLI inline from a public base; build on demand with a content-hash cache; run the agent inside; mount host agent credentials read-only, never baked into a layer. |
| P0-8 | **Generated types.** `.awcli/awcli.d.ts` ambient-declaring the context and project profile; regenerated whenever the producing version differs from the running binary. |
| P0-9 | **Project profile and version gate.** `.awcli/config.json` with a **small fixed schema** — min version, default agent and model, `commands` (test/build/lint), `paths` (docs/standards), sandbox options — plus an open `custom` record surfaced as `ctx.project.custom`, so repo-specific facts never need an awcli release. A version **range** (`"awcli": ">=0.6 <2"`) is enforced at startup, so a semver major is the breaking-change signal, and missing fixed keys fail fast naming the field. A **platform gate** refuses to run on win32, pointing at WSL2 (where the Linux path applies unchanged) rather than failing later on mount translation or process teardown. |
| P0-10 | **Create and resolve.** `awcli create <name>` writing to `~/.awcli/workflows/` (`--project` for `.awcli/workflows/`); `awcli run <name>` resolving project-first then global, bare paths always accepted; `--repo`/`--cwd` to aim any workflow at any checkout; `--arg key=value` surfaced as `ctx.args`. `~/.awcli/workflows` holds **workflows only** — no machine-local state, caches, or logs — so it is a plain git repo the author can push and pull across machines. Anything machine-local lives outside it. |
| P0-11 | **One runtime directory.** All runtime state — worktrees, logs, state, locks — under `.awcli/run/`. The generated `.gitignore` is a single `run/` line, written once at init and never touched again; future runtime paths land inside it automatically. `Dockerfile`, `config`, and `awcli.d.ts` sit outside it and are never auto-ignored. |
| P0-12 | **Logs and lifecycle.** Per-agent log files under `.awcli/run/logs/` plus a compact terminal summary; per-run exclusive lock recording its owning process, with a lock outliving its owner reclaimed automatically and audibly; Ctrl-C teardown (kill subprocesses, remove containers, preserve worktrees, release lock); `awcli clean` (which also collects branches whose worktrees are gone and which are merged or empty, never one carrying unmerged commits); per-iteration failure isolation with a non-zero exit only when every iteration failed. Every run record and log header stamps the awcli version, the agent CLI version, and git HEAD, so a failed overnight run is attributable; each agent call logs its isolation level (`isolation: worktree — host filesystem and network reachable`). |
| P0-13 | **Contract-first types and a fake driver.** `awcli.d.ts` is authored and frozen as an artifact *before* the orchestration behind it, and a `--dry-run` agent driver echoes prompts and returns fabricated results conforming to the declared output schema. Real workflows can be authored, run, and iterated before worktrees or containers exist, and every test afterwards runs without spending tokens. |

**Build order.** P0-13 comes first. The frozen `ctx` contract plus the fake driver are what let the
plumbing underneath (P0-4, P0-6, P0-7) be built and replaced without touching a workflow — and they
turn "is `ctx` any good?" into a question answerable in week one rather than month three.

### P1

| ID | Requirement |
|---|---|
| P1-1 | **Usage reporting with a soft threshold.** Per-iteration and cumulative token usage and cost in logs and the run summary, plus a warning line when cumulative spend crosses a configurable threshold. No abort. Degrades to "unknown" when `stream-json` is unparseable — and says so once at startup rather than implying an active threshold. |
| P1-2 | Additional agent drivers (Codex, Copilot, others) behind the P0-4 interface. |
| P1-3 | `ctx.http`. |
| P1-4 | Workflow templates beyond a blank scaffold. |
| P1-5 | **Local shared base image.** Build `awcli-base:local` once per machine (node + git + a **pinned** agent CLI); generated Dockerfiles use `FROM awcli-base:local` and add their toolchain on top. Docker's layer cache already shares an identical prelude across repos on one daemon, so this is not about repo count — it is about (a) repos whose toolchains need a different `FROM`, which cannot share the agent layer at all, and (b) making the agent version an explicit rebuildable artifact (`awcli upgrade-image`) instead of a cache entry that `RUN npm i -g` pins forever by instruction text. Needs a cache-invalidation rule when the recipe changes. |
| P1-6 | **`awcli doctor`.** One command printing binary version, required range, agent CLI version, image status, and git state — the thing you ask a colleague to run. |
| P1-7 | **Real-agent smoke test.** One trivial live call asserting a tag round-trips and commits are detected. Run on agent-CLI upgrade, not on every commit. |

### P2

| ID | Requirement |
|---|---|
| P2-1 | **Budget enforcement** — `--max-cost` / `--max-tokens` aborting a run. |
| P2-2 | **Native win32 support — not planned.** WSL2 is the Windows path and covers the only Windows user. Revisit only if that changes; the isolated path-mapping and teardown modules are where it would land. |
| P2-3 | Remote/isolated sandbox providers (Vercel, Daytona-style) requiring sync-in/sync-out. |
| P2-4 | Shareable workflow packs and a team distribution story. |
| P2-5 | Docs site and public OSS surface. |

## Non-Functional Requirements

- **First run needs no Docker.** The default path (worktree isolation, no container) must work on a
  clean machine with only awcli installed. Container features degrade with a clear message.
- **No `package.json` required in the target repo.** Any language, any layout.
- **Unattended stability.** A run must survive hours of agent activity: no unbounded memory growth
  from buffered streams, no hang when an agent process fails to exit, no orphaned containers.
- **Legible failures.** Every failure names the thing to fix — the missing config field, the held
  lock, the required version, the absent tag — not a stack trace.
- **Honest isolation language, enforced by naming.** "Sandbox" refers only to the container path.
  The default path is called "worktree" in the API, `--help`, docs, and log output, and every agent
  call states its isolation level at runtime. Worktree isolation protects the repo, not the machine:
  the filesystem outside it, the network, and credentials all remain reachable.
- **No secrets in image layers.** Credentials reach the container by read-only mount only.
- **`ctx` backward compatibility by discipline.** The version gate catches too-old binaries; nothing
  catches behavioral drift in newer ones, so `ctx` changes must be additive.
- **Portable across the author's own machines.** The same workflow library must work from a Mac and
  from WSL2 on Windows. The global workflows directory stays committable (workflows only); anything
  machine-specific belongs in the project profile or run args, never hardcoded in a workflow.
- **Linux-shaped runtime everywhere.** macOS and Linux natively; Windows via WSL2, with clones kept
  inside the WSL2 filesystem rather than `/mnt/c` for git and node performance. No win32-native code
  paths — but `path.join` everywhere, no hardcoded separators, and host→container path mapping and
  process teardown each isolated behind a single module, so nothing forecloses it.
- **Single-machine concurrency safety.** Differently-named runs coexist; same-named runs are refused,
  not interleaved.

## Out of Scope (with rationale)

| Excluded | Rationale |
|---|---|
| Depending on or vendoring `@ai-hero/sandcastle` | Decided (Q1) — awcli owns its orchestration; sandcastle is reference only. |
| Claude Agent SDK in-process execution | Decided (Q2) — subprocess execution is what makes "sandbox the agent" reduce to "run the process in the container", and keeps agents swappable. Costs typed tool events and TS-defined tools. |
| Branch-strategy matrix and auto-merge to HEAD | Decided (Q7) — worktree-per-sandbox delivers safe fan-out; merging is the workflow's job, or a merge agent's. |
| Concurrent-safe shared mutable state across runs | Decided (Q9) — merging arbitrary user-shaped JSON has no principled answer. Named runs plus a lock instead. |
| Self-managing exact version pinning (corepack/mise style) | Decided (Q11) — a declared minimum plus a startup gate, not a version manager. |
| Budget enforcement in v1 | Reporting plus a soft threshold warning first (P1-1); hard ceilings once real numbers exist (P2-1). |
| A published `awcli/base` image | Resolved — a self-contained generated Dockerfile removes the registry, the multi-arch pipeline, and the "two artifacts, one version" coupling entirely. Revisit if colleagues adopt it and fresh-machine build time becomes the complaint. |
| Session resume as a mechanism (retry, continuation) | Resolved — reading an agent's private on-disk session layout is exactly the fragility the git-and-text decision designs out. Retry is a scoped re-ask instead. |
| Windows, public OSS surface, remote sandbox providers | Audience is personal-first; deferred until a team or public need is real. |
| Prompt templating (`{{KEY}}` substitution, shell expansion) | Unnecessary — a TypeScript workflow has template literals and a batteries-included `ctx`. |

## Resolved Questions

All eleven open questions from the grill brief are now closed. The five that changed the shape of
v1:

- **Stream parsing** — truth comes from git and plain text; `stream-json` is optional enrichment
  with per-field degradation. Removes the top technical risk rather than defending against it.
- **Base image** — none. A self-contained generated Dockerfile deletes a release artifact, a CI
  pipeline, and a version-coupling risk from v1.
- **Retry** — a scoped re-ask, not session resume. No coupling to any agent's private session
  storage; the agent's commits survive a malformed tag either way.
- **State** — write-through on mutation (atomic, debounced), frozen inside fan-out scopes, opt-in
  schema validated on hydrate. The three separate state gaps close as one design.
- **Runtime layout** — everything mutable under `.awcli/run/`, so the generated `.gitignore` is one
  line that never needs maintenance.

The rest: non-git directories are refused; a run owns its worktree and state as one resumable unit;
the project profile is a small fixed schema plus an open `custom` bag; spend is reported with a soft
threshold warning. Full rationale in the grill brief's *Gap resolutions*.

## Assumptions

| Assumption | Confidence | What depends on it |
|---|---|---|
| Node ≥22 on macOS, Linux, and WSL2; no win32-native path | **high** | Resolved with the author, who is the only Windows user and already runs WSL2 for Docker. Colleagues are all macOS/Linux |
| The author's global workflow library is synced between machines by the author (git remote), not by awcli | med | P0-10 — awcli's job is only to keep that directory clean enough to commit |
| Docker/Podman needed only for the container path, never a default run | high | The entire first-run experience |
| Target directories are git repositories | med | Worktree-by-default (P0-6) and default isolation (P0-10) |
| Claude Code is the day-one agent | med | How provider-generic `ctx.agent` must be on day one |
| awcli ships as a public npm global package | med | Distribution; no image registry is needed any more |
| A public base image (e.g. `node:22-slim`) plus the agent CLI's own installer is enough to build a working sandbox | med | P0-7 — if the agent CLI has no scriptable install, the generated Dockerfile gets ugly |
| The author is comfortable authoring TypeScript without editor-resolved third-party imports | med | The batteries-included `ctx` bet |
| Audience stays personal until it demonstrably isn't | med | Docs, cross-platform, and contribution scope stay out |

## Definition of Done (v1)

Recommended bar, adopted:

1. **One real unattended workflow.** A workflow the author actually wants — issue triage, PR sustain,
   or a test-fix loop — runs overnight against a real repo, resumes after an induced kill, and
   produces reviewable branches.
2. **A minimal parallel fan-out smoke test.** Two agents, two worktrees, one merge — enough to prove
   concurrency and container isolation work, without porting sandcastle's full parallel-planner. The
   full port is a capability showcase that proves nothing v1 needs; untested parallel worktrees are
   how a 3am run silently clobbers itself.

## Risks

Each risk now names what addresses it. Two are accepted rather than mitigated.

- **The differentiator is `ctx`; the work is everything under it.** From-scratch orchestration
  (worktrees, containers, streams, timeouts, cleanup) is the bulk of v1 and none of it is what makes
  awcli distinct. → *Mitigated by P0-13 and the build order: contract first, fake driver, plumbing
  last. Residual risk accepted — most of v1 is still plumbing, and the answer is scope honesty, not
  cleverness.*
- **`ctx` is a forever contract** — sole API surface, no imports to route around a gap.
  → **Accepted.** Hedges only: keep v1 to its eleven members and refuse additions until a real
  workflow demands one; treat `ctx.exec` plus optional bare imports (in Node repos) as the
  documented pressure valve. Everything else is discipline.
- **Global install without a lockfile.** → *Mitigated by the version range in P0-9 (a semver major
  is the breaking-change signal), version stamping in P0-12, and `awcli doctor` (P1-6). Behavioral
  drift within a major is still uncaught.*
- **Residual stdout coupling.** The enrichment layer and the tagged-output convention still depend
  on the agent behaving as expected. → *Mitigated by loud degradation (P0-4), version stamping for
  attributability (P0-12), and the real-agent smoke test (P1-7).*
- **"Sandboxed" will be over-read.** → *Mitigated by naming: "sandbox" means container only, the
  default path is "worktree" everywhere, and isolation level is logged per agent call (P0-6, P0-12,
  NFR).*
- **Unattended loops spend money.** → *Mitigated by `--max-duration` (P0-2), which cannot degrade
  the way a usage-based threshold can, plus the fake driver for authoring (P0-13) and unknown-aware
  reporting (P1-1). No hard cost ceiling until P2-1.*
- **Fragmented agent-CLI installs across images.** Docker's layer cache shares an identical prelude
  across repos on one daemon, so the naive "every repo pays" reading is wrong — the real costs are
  repos needing a different base image (no sharing possible), a second machine (a second daemon),
  and a cached `RUN npm i -g` layer that silently pins a stale agent version by instruction text.
  → *Mitigated by P1-5 (one local base, pinned agent, explicit rebuild) and made diagnosable by the
  agent-version stamping in P0-12. Unmitigated in v1.*

## Next Steps

- `/specify` — extract business rules and BDD scenarios from this draft
- `/design` — technical design and implementation tickets
- Start with P0-13 — freeze `awcli.d.ts` and build the fake driver — before any orchestration work
