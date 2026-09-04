# Technical Design: awcli — Agentic Workflow CLI

**Date:** 2026-08-24
**Status:** Draft
**Context:** [PRD](../context/agentic-workflow-cli-prd-draft.md) · [Rules](agentic-workflow-cli-rules.md) · [BDD](agentic-workflow-cli-bdd.feature) · [Analysis](agentic-workflow-cli-analysis.md)

## Problem Statement

Orchestrating AI coding agents across repositories today requires installing an orchestration library
into every repository it runs against, which forces each target to be a Node project and makes a
workflow non-portable — it must be copied into each repo. awcli inverts the dependency: a workflow is
a TypeScript file that default-exports a function, and a globally-installed CLI imports it and injects
the API as an argument. Nothing is installed into the target.

## Goals

- Run a workflow against any git repository, in any language, with nothing installed into it.
- Author and test workflows before the orchestration behind them exists (P0-13).
- Survive an unattended multi-hour run: resume after a crash, never damage the operator's checkout,
  always explain afterwards what happened.
- Make one workflow portable across repositories and across the operator's two machines.

## Non-Goals

- Native Windows execution (WSL2 is the Windows path — ADR-0007).
- A published container image (ADR-0006), remote execution targets, or multi-repo runs.
- A hard spend ceiling (v1 reports and warns; the enforceable bound is wall-clock).
- Branch-strategy matrices or automatic merging — branches are the workflow's to dispose of.

## Proposed Solution

### Architecture Overview

```
                 awcli run <name> --repo <path> --iterations N --max-duration T
                                        |
   ┌────────────────────────────────────▼─────────────────────────────────────┐
   │ Gate chain      platform → git → version range → entry point → profile   │  refuse early,
   │                 → prompt tags → state shape → lock (reclaim if stale)    │  before any effect
   └────────────────────────────────────┬─────────────────────────────────────┘
                                        |
   ┌────────────────────────────────────▼─────────────────────────────────────┐
   │ Functional core   loop · termination · state decisions · validation      │  no side effects
   └───┬─────────────┬──────────────┬──────────────┬──────────────┬───────────┘
       |             |              |              |              |
   AgentDriver   ExecTarget     Workspace       Store          Clock            ← ports
   claude|fake   host|container liveTree|worktree filesystem    system|fixed
       |             |              |              |
   subprocess    docker exec    git worktree   .awcli/run/                      ← adapters
                                        |
   ┌────────────────────────────────────▼─────────────────────────────────────┐
   │ Disposal stack   subprocesses → containers → worktree handles → lock      │  unwound in
   └──────────────────────────────────────────────────────────────────────────┘  reverse, always
```

The context handed to the workflow is assembled per iteration by a factory closing over the ports.
A `sandbox()` scope is the same factory with a read-only state capability, which is how BR-012 is
enforced structurally for that half (ADR-0005). The `agent()` fan-out half cannot be bought that
way at all: `agent()` hands back a result rather than a child context, so a fan-out branch is the
body's own code holding the body's own context, and there is no child scope to give a different
capability to. That half is a run-time refusal on a time window — no shared-state write while an
agent call the body started is still in flight. AWCLI-10 builds both.

### Component Design

#### Gate chain

**Responsibility:** Refuse before any side effect, cheapest and most certain first, so nobody waits
on a container build to learn their platform is unsupported.
**Order:** platform (BR-001) → repository (BR-002) → version range (BR-003) → entry point (BR-005) →
profile fields (BR-006) → prompt tags (BR-007) → state shape (BR-009) → lock (BR-010, BR-035).
**Note:** every gate returns a refusal naming the thing to fix; none throws a stack trace.

#### Functional core

**Responsibility:** Decide, never act. Iteration sequencing, termination classification, state
transition validation, spend accounting.
**Business rules:** BR-017 (invoke per pass), BR-018 (four exits, workflow declares whether limit
exhaustion counts as finished), BR-019 (iteration failure isolation), BR-037 (declared-done awaits
in-flight work), BR-027 (spend accounting).

#### Ports

| Port | Responsibility | Implementations (v1) |
|---|---|---|
| `AgentDriver` | Start an agent, surface its output, report liveness | `claude`, `fake` |
| `ExecTarget` | Run a command somewhere | `host`, `container` |
| `Workspace` | Provide a directory and branch to work in | `liveTree`, `worktree` |
| `Store` | Durable state, run records, locks, logs | `filesystem` |
| `Clock` | Now, elapsed, deadlines | `system`, `fixed` |

#### Disposal stack

**Responsibility:** One owned mechanism registering every releasable resource and unwinding in
reverse on any exit path — normal end, iteration failure, interrupt, or crash of the workflow body.
**Rules:** BR-021 (lock always released, worktrees always preserved), BR-037 (await-then-end as a
distinct cancellation mode from interrupt-now).
**Note:** this is the acknowledged weak point of a framework-free design (ADR-0001) and is therefore
built and tested first (WB-2), before anything registers with it.

### Alternatives Considered

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| **Functional core + driver ports** | Every hard part has a home; rehearsal is a driver; time limits testable instantly | Disposal and cancellation hand-rolled | **Chosen** — the only option satisfying P0-13 |
| Effect runtime (as sandcastle) | `Scope` cleanup, structured concurrency, typed refusals | Reintroduces the dependency Q1 removed; public surface must be kept framework-free anyway | Rejected — ADR-0001 |
| Thin orchestrator, shell out inline | Fastest to a working command | No seams; rehearsal becomes scattered conditionals | Rejected — defeats P0-13 |

**Decision Rationale:** [Source: PRD P0-13, BR-033/BR-034] — the authoring and test strategy depends
on substitution, so the agent must be a port. Trade-off accepted: hand-rolled disposal, mitigated by
owning it as a single tested mechanism from the first commit.

### Persisted Shapes

Replaces a data schema — awcli has no database. All of it lives under one runtime directory so the
generated ignore entry is a single line written once (BR-030).

```
<repo>/.awcli/
  Dockerfile          committed, operator-owned, self-contained (ADR-0006)
  config.json         committed — version range, profile (fixed keys + custom), thresholds
  awcli.d.ts          committed, generated — the frozen context contract (ADR-0002)
  .gitignore          generated once, never rewritten: a single `run/` line
  run/                all mutable state — the only ignored path
    <run>/state.json      shared state, atomic temp+rename, write-through (ADR-0005)
    <run>/record.json     iterations, outcomes, versions, HEAD, spend (BR-025)
    <run>/lock            owner process + start time, reclaimable when dead (BR-035)
    <run>/logs/<agent>.log per-agent output (BR-028)
    worktrees/<run>/<slot>  working copies; branch awcli/<run>/<slot> (BR-036)

~/.awcli/workflows/     global library — workflows only, syncable, never written to (BR-029)
```

### Security Considerations

- **Worktree isolation is not security isolation.** It protects the repository, not the machine. The
  filesystem outside the repo, the network, and credentials remain reachable on the default path.
  Mitigated by naming and by stating the isolation level at every agent call (BR-015).
- **Credentials are lent, never copied.** Read-only mount for the life of the run; never written into
  an image layer, which outlives the run and can be pushed (BR-016).
- **Agent output is untrusted data.** Tagged results are parsed as data and validated against a
  schema — never evaluated, never used to construct a shell command. An agent can emit anything.
- **`--arg` values and profile fields may carry secrets.** They appear in run records and logs;
  redaction of values matching known secret shapes is a v1 concern in WB-13.
- **The lock is not a security boundary.** It prevents accidental concurrent runs by one operator,
  nothing more.
- **A requested container never silently downgrades** (BR-004) — the one failure mode that could put
  an agent outside the boundary the operator asked for.

---

## Contracts

### Entry points — CLI commands

| Command | Purpose | Key options | Refusals |
|---|---|---|---|
| `awcli run <name-or-path>` | Run a workflow | `--repo`, `--iterations`, `--max-duration`, `--name`, `--fresh`, `--dry-run`, `--arg k=v`, `--reset-state`, `--live-checkout` | BR-001…010, BR-035 |
| `awcli create <name>` | Scaffold a workflow | `--project`, `--template` | Name already exists |
| `awcli init` | Write `.awcli/` into a repository, including all five required profile fields — `commands.test`, `commands.build`, `commands.lint`, `paths.docs`, `paths.standards` (BR-006) | — | BR-002 |
| `awcli clean` | Release leftovers; collect branches | `--run`, `--branches` | Never touches unmerged commits (BR-036) |
| `awcli doctor` | Report versions, ranges, image and git state | — | — (P1-6) |

**Exit codes** — the machine-readable form of BR-018, so a scheduler can alert without reading logs:

| Code | Meaning |
|---|---|
| `0` | Finished — the workflow declared itself done, or exhausted a limit it declared as completion |
| `1` | Failed — every iteration failed |
| `2` | Incomplete — a limit was exhausted and the workflow did not declare that as completion |
| `3` | Refused — a gate rejected the run before any side effect |

### Entry point — the workflow module contract

| Export | Signature | Purpose |
|---|---|---|
| `default` | `(ctx: WorkflowContext) => Promise<WorkflowResult \| void>` | Invoked once per iteration (BR-017) |
| `limits` (optional) | `{ exhaustionIsCompletion: boolean }` | Declares whether exhausting a limit counts as finished; default `false` (BR-018) |
| `state` (optional) | schema | Declared state shape, validated on load (BR-009) |

`WorkflowResult`: `{ done?: boolean }` — `done` ends the loop after awaiting in-flight work (BR-037).

### Context surface — the frozen contract

| Member | Shape | Rules |
|---|---|---|
| `ctx.agent(opts)` | `(opts: AgentOptions) => Promise<AgentResult>` | BR-013, BR-020, BR-022 |
| `ctx.sandbox(opts)` | `(opts: SandboxOptions) => Promise<Scope>` — worktree × container | BR-004, BR-016 |
| `ctx.state` | mutable record in the body; read-only view inside a `sandbox()` scope; unwritable while the body's own agents are in flight | BR-008, BR-012, BR-023 |
| `ctx.args` | `Record<string, string>` from `--arg` | P0-10 |
| `ctx.project` | fixed profile fields + `custom` record | BR-006 |
| `ctx.git` | branch, log, diff, commit helpers | BR-036 |
| `ctx.exec` | run a command in the current workspace and target | BR-032, BR-040 |
| `ctx.fs` | read/write within the workspace | BR-038 |
| `ctx.log` | structured logging attributed to run/iteration/agent; field values are unconstrained and checked when the line is written | BR-008, BR-025, BR-028 |
| `ctx.env` | the run's environment, asked one name at a time — `get`/`has`, never a record | BR-039 |
| `ctx.schema` | validator used for output and state shapes | BR-008, BR-009, BR-020 |
| `ctx.version` | the running contract version, for feature detection | BR-033 |

Every function on this surface — top level and inside the sub-APIs — is a member a workflow cannot
assign over (BR-025). Without that, a module the workflow imported without reading could replace
`log.info` and the run would agree with itself while recording nothing, and a scope's own `exec` or
`fs` could be swapped for the body's after the scope was made. It is hygiene against accident, not a
boundary: the workflow shares awcli's process.

`AgentOptions`: `{ prompt, promptFile?, model?, output?: { tag, schema }, timeoutSeconds?, name? }`.
`AgentResult`: `{ commits, output, isolation, usage?, logPath }` — `commits` from git, `output` from
text, `usage` possibly unknown (ADR-0004).

### Ports — service contracts

| Port | Methods |
|---|---|
| `AgentDriver` | `start(prompt, target, opts) → AgentHandle`; `AgentHandle.output(): AsyncIterable<string>`; `wait(): Promise<Exit>`; `kill(): Promise<void>` |
| `ExecTarget` | `exec(cmd, opts) → Promise<ExecResult>`; `available(): Promise<boolean>`; `dispose(): Promise<void>` |
| `Workspace` | `acquire(run, slot) → Promise<WorkspaceHandle>`; `WorkspaceHandle.dir`, `.branch`, `.head()`, `.dirty()`; `release(preserve: true)` |
| `Store` | `loadState(run)`, `saveState(run, data)` (atomic), `appendRecord(run, entry)`, `acquireLock(run)`, `reclaimIfStale(run)`, `logStream(run, agent)` |
| `Clock` | `now()`, `elapsed(since)`, `deadline(duration)` |

### Data access — `Store` guarantees

| Method | Guarantee |
|---|---|
| `saveState` | Temp file plus rename; a partial write is never observable (BR-023) |
| `acquireLock` | Records owner process and start time; fails if held by a live owner (BR-010) |
| `reclaimIfStale` | Reclaims only when the owner is gone, and reports that it did (BR-035) |
| `appendRecord` | Append-only; stamps awcli version, agent version, HEAD (BR-025) |

---

## Work Breakdown

### WB-1: Freeze the context contract and ship the fake driver
- **Summary:** [AWCLI] Author the frozen context declaration and a fake agent driver so workflows can be written before orchestration exists
- **Story Points:** 5
- **Dependencies:** none — this is first (P0-13 build order)
- **Contracts:** Context surface; workflow module contract; `AgentDriver`
- **Acceptance Criteria:**
  - [ ] The declaration compiles standalone and the runtime is asserted against it at build time
  - [ ] *A workflow written earlier still runs on a later awcli*
  - [ ] *A workflow cannot put its own function over the one that writes the record*
  - [ ] *A rehearsal is free and touches nothing real*
  - [ ] *A rehearsal still creates a working copy*
  - [ ] A real workflow can be authored and run end-to-end with no agent installed

### WB-2: Disposal and cancellation spine
- **Summary:** [AWCLI] Build the disposal stack and cancellation primitive before anything registers with them
- **Story Points:** 5
- **Dependencies:** none
- **Contracts:** Disposal stack; `ExecTarget.dispose`; `Workspace.release`
- **Acceptance Criteria:**
  - [ ] Resources unwind in reverse on normal end, failure, interrupt, and a throw from the workflow body
  - [ ] *Interrupting a run leaves nothing locked and loses nothing*
  - [ ] *Interrupting is still the immediate stop*
  - [ ] Await-then-end and interrupt-now are distinct modes of one primitive
  - [ ] A leaked resource fails a test rather than being noticed in production

### WB-3: Workflow loader and entry-point validation
- **Summary:** [AWCLI] Load a TypeScript workflow with a bundled loader and validate its exports
- **Story Points:** 3
- **Dependencies:** WB-1
- **Contracts:** Workflow module contract
- **Acceptance Criteria:**
  - [ ] *A workflow file with no usable entry point is refused*
  - [ ] The project's `tsconfig.json` is ignored entirely
  - [ ] Optional `limits` and `state` exports are read when present

### WB-4: Gate chain
- **Summary:** [AWCLI] Refuse unsupported platform, non-repository, version mismatch, missing profile fields and absent prompt tags before any side effect
- **Story Points:** 3
- **Dependencies:** WB-3
- **Contracts:** Entry points; `ctx.project`
- **Acceptance Criteria:**
  - [ ] *Native Windows is refused with a route forward*
  - [ ] *A directory that is not a repository is refused*
  - [ ] *An awcli older than the repository requires is refused*
  - [ ] *An awcli within the required range proceeds*
  - [ ] *A repository that requires nothing accepts any version*
  - [ ] *A portable workflow meeting a repository that lacks a fact it needs*
  - [ ] *A missing profile field is refused even when no workflow reads it*
  - [ ] *The free-form part of a profile carries no guarantee*
  - [ ] *Asking for tagged output the prompt never requests*
  - [ ] Gates run cheapest-first; no container work precedes any refusal

### WB-5: Run identity, locking and the run record
- **Summary:** [AWCLI] Name runs, take an exclusive lock reclaimable when its owner dies, and record every run for attribution
- **Story Points:** 3
- **Dependencies:** WB-2
- **Contracts:** `Store.acquireLock`, `reclaimIfStale`, `appendRecord`
- **Acceptance Criteria:**
  - [ ] *Two runs of the same name cannot overlap*
  - [ ] *Differently named runs may overlap*
  - [ ] *A lock left by a killed run is reclaimed automatically*
  - [ ] *A slow run keeps its lock*
  - [ ] *Every run can be explained the next morning*

### WB-6: Durable state with write-through and a single writer
- **Summary:** [AWCLI] Persist shared state as it changes, reject unstorable values at assignment, make a `sandbox()` scope's state read-only, and refuse a body write while the body's own agents are still running
- **Story Points:** 5
- **Dependencies:** WB-2, WB-5
- **Contracts:** `ctx.state`; `Store.loadState`, `saveState`
- **Note:** the single writer takes two mechanisms and this unit builds both, because the two ways a
  workflow leaves its body have different shapes (BR-012, ADR-0005). `sandbox()` returns a scope, so
  its read-only state is structural and a write there does not compile. `agent()` returns a result
  and not a scope, so there is no child scope to freeze — a fan-out branch is the body's own code
  holding the body's own context — and what is refused is a write made while an agent call the body
  started is still in flight. Anything describing an "agent scope" is the retracted model; there is
  no such object on the surface.
- **Acceptance Criteria:**
  - [ ] *A value that cannot be stored is rejected where it was set*
  - [ ] *Stored state no longer matching the shape the workflow declares*
  - [ ] *A parallel branch may read shared state but not write it*
  - [ ] *A write while the body's own agents are still running is refused*
  - [ ] *The workflow body records results returned from its branches*
  - [ ] *A crash mid-iteration does not discard what was recorded*
  - [ ] A partial write is never observable

### WB-7: Iteration loop and termination
- **Summary:** [AWCLI] Drive iterations, classify the four ways a run ends, and isolate per-iteration failure
- **Story Points:** 5
- **Dependencies:** WB-6
- **Contracts:** Functional core; workflow `limits` export
- **Acceptance Criteria:**
  - [ ] *The tool drives the loop and carries state across passes*
  - [ ] *Finishing the work early is reported as finished*
  - [ ] *Exhausting the iterations is incomplete unless the workflow says otherwise*
  - [ ] *A monitor-style workflow declares that exhausting its limits is expected*
  - [ ] *The time limit ends a run the iteration count would not have*
  - [ ] *One bad iteration does not end the night* / *A run where nothing succeeded is a failed run* / *A precondition failure stops the loop immediately*
  - [ ] *Declaring done lets work already in flight finish*

### WB-8: Workspace port — worktrees, branches, reuse
- **Summary:** [AWCLI] Provision worktrees on deterministic branches, reuse them across iterations, and report inherited state on resume
- **Story Points:** 5
- **Dependencies:** WB-2, WB-5
- **Contracts:** `Workspace`; `ctx.git`
- **Acceptance Criteria:**
  - [ ] *The default protects my checkout* / *Working on the live checkout requires asking for it*
  - [ ] *Parallel agents never share a working copy*
  - [ ] *Resuming a run reattaches the branch it already had*
  - [ ] *Resuming restores the work and says what it inherited*
  - [ ] *Starting fresh discards state and working copies together*
  - [ ] *Branches survive the run that made them*

### WB-9: Claude agent driver
- **Summary:** [AWCLI] Run the agent as a subprocess, take commits from git and results from text, and handle silence and lingering processes
- **Story Points:** 5
- **Dependencies:** WB-1, WB-8
- **Contracts:** `AgentDriver`; `AgentResult`
- **Acceptance Criteria:**
  - [ ] Commits come from the repository, not from parsed output
  - [ ] *An agent that goes silent fails its iteration*
  - [ ] *An agent that finished but has not exited is treated as successful*
  - [ ] *Detail that cannot be read degrades once and loudly*
  - [ ] Works against an agent invoked with no structured output mode at all

### WB-10: Structured output extraction and scoped re-ask
- **Summary:** [AWCLI] Extract tagged results, validate them, and re-ask narrowly once before failing the iteration
- **Story Points:** 3
- **Dependencies:** WB-9
- **Contracts:** `AgentOptions.output`; `ctx.schema`
- **Acceptance Criteria:**
  - [ ] *A malformed result is re-asked for, not re-done*
  - [ ] *A result that stays malformed costs the iteration, not the work*
  - [ ] The re-ask instructs the agent to change nothing
  - [ ] Output is parsed as data — never evaluated

### WB-11: Container execution target
- **Summary:** [AWCLI] Generate a self-contained Dockerfile, build it on demand with a content-hash cache, and run agents inside it with credentials mounted read-only
- **Story Points:** 5
- **Dependencies:** WB-2, WB-8
- **Contracts:** `ExecTarget` (container); `ctx.sandbox`
- **Acceptance Criteria:**
  - [ ] *A requested container is never silently downgraded*
  - [ ] *A workflow that asks for no container is unaffected by its absence*
  - [ ] *Credentials are lent to a container, never baked into it*
  - [ ] A rebuild happens only when the Dockerfile's content changes

### WB-12: Workflow resolution, scaffolding and arguments
- **Summary:** [AWCLI] Resolve workflows project-first then global, scaffold new ones, and pass invocation arguments through
- **Story Points:** 3
- **Dependencies:** WB-3
- **Contracts:** `awcli create`; `ctx.args`; `awcli run --live-checkout` (the operator's own flags on
  `run`, which are consumed rather than forwarded — added by the 2026-08-28 `--live-checkout` amendment)
- **Acceptance Criteria:**
  - [ ] *A project's own workflow shadows the shared one* / *The shared workflow is used when the project has none*
  - [ ] *An explicit path is always honoured*
  - [ ] *The workflow library stays clean enough to sync between machines*
  - [ ] *A repository in another language needs nothing installed*
  - [ ] *A workflow that reaches past the context takes on that requirement itself*

### WB-13: Logging, isolation reporting and spend
- **Summary:** [AWCLI] Give every agent its own log, keep the terminal readable, state isolation per call, and report spend with an unknown-aware threshold
- **Story Points:** 3
- **Dependencies:** WB-5, WB-9
- **Contracts:** `ctx.log`; `Store.logStream`
- **Acceptance Criteria:**
  - [ ] *Four agents at once stay readable*
  - [ ] *Every agent call states how isolated it is*
  - [ ] *Spend is reported and a threshold warns*
  - [ ] *A threshold that cannot be measured says so up front*
  - [ ] *A log field that cannot be written down costs the field, not the run*
  - [ ] Values matching known secret shapes are redacted from records and logs

### WB-14: Runtime layout, ignore-once and clean
- **Summary:** [AWCLI] Put all mutable state under one runtime path, write the ignore entry once, and collect only what is safe to remove
- **Story Points:** 3
- **Dependencies:** WB-5, WB-8
- **Contracts:** `awcli init`, `awcli clean`; persisted shapes
- **Acceptance Criteria:**
  - [ ] *The generated ignore entry is written once and then left alone*
  - [ ] *Collecting tidies only what is safe to remove*
  - [ ] Committed artifacts are never added to the ignore entry
  - [ ] A new runtime path in a later version needs no ignore change

### WB-15: Workspace-confined filesystem

- **Summary:** [AWCLI] Resolve a workflow's paths against the working copy it was given, and refuse the ones that leave its tree
- **Story Points:** 2
- **Dependencies:** WB-1, WB-8, WB-17
- **Contracts:** `ctx.fs`
- **Acceptance Criteria:**
  - [ ] *A workflow's paths are read against the working copy it was given*
  - [ ] *A path that climbs out of the working copy is refused*
  - [ ] *A path given from the root of the machine is refused*
  - [ ] *A link pointing out of the working copy is refused*
  - [ ] *A path into the working copy's git administrative area is refused*
  - [ ] *Reaching outside the working copy on purpose is not refused*
  - [ ] One resolver, shared with `promptFile`, which is confined on the same terms

### WB-16: Resolved environment

- **Summary:** [AWCLI] Answer the environment one name at a time, with what awcli set for this run answering as unset
- **Story Points:** 2
- **Dependencies:** WB-1, WB-11, WB-17
- **Contracts:** `ctx.env`
- **Acceptance Criteria:**
  - [ ] *A variable awcli set for this run answers as not set*
  - [ ] *My own environment is still there, an inherited API key included*
  - [ ] *On the host target there may be nothing to leave out*
  - [ ] *The environment answers by name and is never handed over whole*
  - [ ] *A command the workflow runs still sees the whole environment*
  - [ ] The subtracted-name set is defined once, beside the credential mount it mirrors

### WB-17: Host execution target

- **Summary:** [AWCLI] Run commands on the default target, reporting plainly what a command there can reach
- **Story Points:** 2
- **Dependencies:** WB-1, WB-8
- **Contracts:** `ctx.exec` (host)
- **Acceptance Criteria:**
  - [ ] *The default execution target is named for what it is*
  - [ ] *A repository's declared command runs whole on the host*
  - [ ] *A value from elsewhere cannot become a second command*
  - [ ] Nothing in the output describes the default target as containment

**Total: 62 points across 17 units.** Critical path: WB-1 → WB-3 → WB-4, with WB-2 in parallel from
day one; nothing downstream of WB-2 may register a resource before it exists.

WB-15, WB-16 and WB-17 were added in PR #8's fourth review round, and they are the design layer
catching up rather than new work: AWCLI-23, AWCLI-24 and AWCLI-25 already existed, at the same two
points and the same dependencies, created when `ctx.fs`, `ctx.env` and `ctx.exec`-on-the-host were
each found to be a context member no unit delivered. Until now the breakdown recorded that gap by
having nothing to say about them, which left fourteen of the feature file's scenarios carried by no
unit at all — the drift a builder reading this section would have inherited. Points move 56 → 62
with them; no ticket estimate changed.

---

## Implementation Context

| Type | Path | Purpose |
|---|---|---|
| bdd | design/agentic-workflow-cli-bdd.feature | 78 scenarios, every rule tagged — 59 approved, 19 pending re-approval |
| rules | design/agentic-workflow-cli-rules.md | 40 business rules — 30 approved, 10 pending re-approval |
| context | context/agentic-workflow-cli-prd-draft.md | Source PRD (13 P0 / 7 P1 / 5 P2) |
| context | context/agentic-workflow-cli-grill-brief.md | 13 architecture decisions and their rationale |
| flows | design/agentic-workflow-cli-flows.md | 7 diagrams |
| analysis | design/agentic-workflow-cli-analysis.md | Architecture alternatives and the chosen option |
| adr | docs/adr/0001-plain-typescript-with-driver-ports.md | Functional core + ports, no Effect |
| adr | docs/adr/0002-contract-first-ambient-context-types.md | Hand-authored contract, compile-time conformance |
| adr | docs/adr/0003-workspace-and-execution-as-orthogonal-axes.md | Two axes, not three isolation modes |
| adr | docs/adr/0004-git-and-text-as-source-of-truth.md | Stream output is enrichment only |
| adr | docs/adr/0005-cli-owned-loop-with-durable-single-writer-state.md | Loop ownership, write-through, one writer by two mechanisms |
| adr | docs/adr/0006-no-published-base-image.md | Self-contained generated Dockerfile |
| adr | docs/adr/0007-wsl2-is-the-windows-path.md | WSL2 supported, native win32 refused at startup |
| reference | ../../mp-sandcastle | Reference implementation — read for lessons, do not depend on |
