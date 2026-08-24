---
feature: agentic-workflow-cli
status: resolved
gaps: 0
open_questions: 0
---
## Sharpened problem
`awcli` is a globally-installed CLI that creates and runs TypeScript agentic workflows. A workflow
file default-exports `async function workflow(ctx)`; the CLI dynamically imports it and invokes that
function once per iteration, injecting a context object rather than being imported by it. Inverting
sandcastle's import-the-library model is what removes the per-project `npm install` — and, because
target repos may not be Node projects at all, it makes `ctx` the *entire* API surface: agents,
sandboxes, git, state, shell, filesystem, logging, schema validation, project profile. The CLI owns
the loop and persists `ctx.state` to disk so long runs resume. Workflows live in a global library
with per-project overrides, so one workflow can be aimed at many repos — which is the actual payoff
of a global install, and the reason a per-repo profile (`.awcli/config.json`) has to exist as the
seam a portable workflow reads.

## Decisions
- **Q1 — Foundation: reimplement from scratch.** Sandcastle is reference only. Worktrees, sandbox
  lifecycle, agent invocation, stream parsing, timeouts, and cleanup are all in scope; its 20 ADRs
  are lessons to re-derive, not inherit. Sequencing an MVP matters more than API elegance.
- **Q2 — Agent execution: spawn agent CLIs as subprocesses.** `ctx.agent()` shells out to
  `claude -p --output-format stream-json` (and peers) and parses the stream. Sandboxing reduces to
  "run the process in the container", host CLI auth is reused, agents stay swappable. Corollary:
  anything `ctx.agent()` returns must be recoverable from a text stream — no in-process tool hooks,
  no typed tool events, no TS-defined tools.
- **Q3 — Loop and state: CLI owns the loop; state is durable.** `awcli run wf.ts --iterations N`
  invokes `workflow(ctx)` per iteration; `ctx.state` is hydrated at entry and flushed after each
  pass, so a killed run resumes. Accepted: JSON-serializable state only, no live handles across
  iterations, module re-invoked per pass (which buys mid-run hot-reload of an edited workflow).
- **Q4 — ctx types: a generated local `.d.ts`, no package.** awcli writes `.awcli/awcli.d.ts`
  ambient-declaring the context type; scaffolds reference it relatively. No npm install, no
  `package.json`, so Python/Go/Rust repos are first-class targets. Regenerated from the binary, so
  types cannot drift from runtime.
- **Q5 — ctx is batteries-included.** With no `node_modules` and no `@types/node`, a workflow cannot
  reliably import anything. `ctx` carries the standard library: exec/shell, fs, log, git, env,
  schema, http. Consequence: every gap in `ctx` is unclimbable, and its stability *is* the
  compatibility contract.
- **Q6 — Sandbox image: generated `.awcli/Dockerfile` FROM a published `awcli/base`.** The base ships
  the agent CLIs and git; users extend it with their toolchain; awcli builds on demand and caches by
  content hash. The base image becomes a versioned artifact released in lockstep with the binary.
- **Q7 — Git: a worktree per sandbox, no auto-merge.** Each `ctx.sandbox()` gets its own worktree on
  its own branch under `.awcli/worktrees/`; the agent commits there; the workflow disposes of
  branches itself. Buys safe parallel fan-out without a branch-strategy matrix.
- **Q8 — Agent output: tag + schema with validated auto-retry.** `ctx.agent({ output: { tag, schema }})`
  extracts the tagged block, validates it, and re-prompts for a corrected block a bounded number of
  times before failing. Pulls **session resume** (`claude --resume <id>`) into v1 — so session-id
  capture and per-CLI resume flags are v1 work.
- **Q9 — Concurrency: named runs, exclusive lock, single-writer state.** A run's name (`--name`,
  defaulted from the filename) keys its state file, worktree namespace, and container names; a
  lockfile fails a second same-named run fast. Parallel agents get distinct worktrees; `ctx.state`
  is written by the workflow body only.
- **Q10 — Default isolation: worktree, not container.** With no sandbox requested the agent still
  runs in a fresh worktree on its own branch; the live working tree requires explicit opt-in. First
  run works with zero Docker setup. Must be documented as isolation, **not** security — filesystem
  outside the repo, network, and credentials remain reachable.
- **Q11 — Versioning: declared minimum, checked at startup.** `.awcli/config.json` carries
  `"awcli": ">=x.y"`; an older binary refuses to run and names the requirement. The generated
  `.d.ts` is regenerated whenever the producing version differs, removing the stale-types failure
  mode. No protection against a *newer* binary — `ctx` stays backward-compatible by discipline.
- **Q12 — Workflow home: global library with project overrides.** `awcli create <name>` writes to
  `~/.awcli/workflows/` by default (`--project` for `.awcli/workflows/`); `awcli run <name>`
  resolves project-first then global; a bare path always works. `--repo`/`--cwd` aims any workflow
  at any checkout, and `ctx` names the target repo explicitly instead of leaning on `process.cwd()`.
- **Q13 — Project seam: typed profile plus run args.** `.awcli/config.json` holds the per-repo
  profile (test/build/lint commands, default agent and model, docs and standards paths, issue
  tracker), surfaced as `ctx.project` and typed by the generated `.d.ts`; `--arg key=value` becomes
  `ctx.args`. A missing key fails fast naming the config field.

## Gaps & missed areas
None outstanding — all eleven are resolved below.

## Gap resolutions
- **Stream-parse containment → truth from git and text; `stream-json` is optional enrichment.**
  Commits come from `git log base..HEAD` in the worktree, structured output and completion signals
  from plain text scanning, timeouts from any output at all — none of which an agent-CLI update can
  break. `stream-json` is parsed opportunistically for usage and tool-call visibility, every field
  degrading to undefined rather than throwing. Revises the Q8 corollary: session id is no longer a
  dependency.
- **Structured-output retry → a scoped re-ask, not session resume.** A fresh, narrow agent call
  ("do not change files; emit only a corrected `<tag>` block"), bounded, then fail the iteration
  with the validation detail. Because commits are git-truth, a malformed tag never loses the
  agent's work.
- **Mid-iteration state loss → write-through on mutation.** Debounced atomic writes (temp file plus
  rename). `ctx.state.save()` remains as an explicit flush. Workflows must tolerate seeing
  mid-iteration state on resume.
- **Parallel-branch state writes → read-only inside agent and sandbox scopes.** Child contexts
  expose `ctx.state` frozen, so a write from inside a fan-out branch throws immediately pointing at
  the correct pattern. Single-writer is now structural, not documentary.
- **State shape drift → opt-in schema validated on hydrate.** A workflow may declare its state
  shape via `ctx.schema`; mismatch fails at startup with the validation detail and suggests
  `--reset-state`. No declaration means no validation.
- **Base image → there isn't one.** The generated `.awcli/Dockerfile` installs git and the agent CLI
  inline from a public base. No registry, no multi-arch pipeline, no supply-chain surface, and the
  "two artifacts, one version" risk is deleted rather than managed. Cost: a slower first build per
  repo, absorbed by the content-hash cache.
- **Profile scope creep → small fixed schema plus an open `custom` bag.** awcli owns min version,
  default agent and model, commands (test/build/lint), paths (docs/standards), and sandbox options;
  everything else lives in `ctx.project.custom`, so repo-specific facts never require an awcli
  release.
- **`.gitignore` maintenance → one runtime directory, one ignore line.** All runtime state
  (worktrees, logs, state, locks) lives under `.awcli/run/`; the generated `.gitignore` is a single
  line written once and never touched again, and any future runtime path lands inside it
  automatically. Committed artifacts sit outside it and are never auto-ignored.
- **Non-git directories → refuse with a clear message.** Worktree isolation and "what did this run
  change?" are both meaningless without git; awcli says so and suggests `git init`.
- **Reuse versus resume → the run owns both, as one unit.** A named run owns its worktree and its
  state; both are reused across iterations and both are what resume restores. awcli records the
  worktree's HEAD and dirty status so a resume can report inherited uncommitted work. `--fresh`
  discards both together.
- **Spend visibility → report plus a soft threshold warning.** Per-iteration and cumulative
  usage/cost in logs and the run summary, with a warning line at a configurable threshold. No
  abort. Figures degrade to unknown when `stream-json` is unparseable, so the threshold can
  silently never fire.

## Resolved defaults
All twelve open questions are now closed on the recommended default, except the last, which the
user amended.

- **TS loader:** bundle `tsx`; ignore the project's `tsconfig.json` entirely.
- **State writes:** in-place mutation on `ctx.state`, flushed at iteration boundaries, with a clear
  error when it will not serialize, plus an explicit `ctx.state.save()` for long iterations.
- **Loop termination:** `return { done: true }` ends the loop; `ctx.stop()` is the escape hatch from
  deep in the call stack; distinct exit codes for "completed" versus "hit the iteration cap".
- **Iteration failure:** fail that iteration, continue the loop, exit non-zero only if every
  iteration failed.
- **Reuse:** worktrees and containers are reused across iterations by default; `--fresh` recreates
  them.
- **Logging:** per-agent log files under `.awcli/logs/` plus a compact terminal summary.
- **Credentials:** mount the host agent config read-only into the container; never bake into an
  image layer.
- **Ctrl-C:** kill agent subprocesses, remove containers, preserve worktrees for inspection, release
  the lock. `awcli clean` reclaims.
- **Agents in v1:** Claude Code only, behind a driver interface the others implement later.
- **`ctx` in v1:** agent, sandbox, state, args, project, exec, fs, log, git, env, schema. `schema`
  is non-optional — Q8 depends on it. `http` deferred.
- **Bare imports in a workflow file:** permitted but unsupported — normal Node resolution,
  documented as "only if your repo is a Node project".
- **Generated files and git (amended):** `Dockerfile`, `config`, and `awcli.d.ts` are ordinary
  tracked files — awcli never adds them to an ignore list, so a fresh clone has working types by
  default. awcli generates `.awcli/.gitignore` covering only the runtime paths (`worktrees/`,
  `logs/`, `state`). That file is user-owned once created: awcli must not clobber it or re-add
  entries a user removed, and a user who prefers to ignore the three artifacts (regenerating them
  per machine) just adds them there.

## Assumptions
- Node ≥22 on macOS/Linux; Windows deferred. **low** — sandcastle carries explicit Windows mount
  handling, so ignoring it is a real decision, not an oversight.
- Docker/Podman is needed only for the container path, never for a default run. **high** — follows
  from Q10; the whole first-run experience depends on it holding.
- Target directories are git repositories. **med** — Q7 and Q10 both assume it.
- Claude Code is the day-one agent; the driver interface keeps others viable. **med** — affects how
  provider-generic `ctx.agent` must be on day one.
- awcli ships as a public npm global package plus a public base image. **med** — Q6 and Q11 both
  depend on a publishing pipeline that does not exist yet.
- Users are comfortable authoring TypeScript without editor-resolved third-party imports. **med** —
  the batteries-included bet rests on this.

## Risks
- **The differentiator is `ctx`; the work is everything under it.** From-scratch orchestration
  (worktrees, containers, streams, timeouts, cleanup) is the bulk of the build and none of it is
  what makes awcli distinct. Easy to spend the whole budget on plumbing.
- **`ctx` is a forever contract.** Sole API surface, no imports to route around a gap, and a
  generated `.d.ts` that promises whatever it declares.
- **Global install without a lockfile.** A minimum-version check catches too-old binaries; nothing
  catches behavior drift in newer ones, and CI/teammates will hit it first.
- **Agent stdout is an unstable interface.** Every capability derived from stream parsing can break
  on an agent CLI release you don't control.
- **"Sandboxed" will be over-read.** Worktree isolation protects the repo, not the machine; users
  will assume more than it delivers.
- **Two artifacts, one version.** Binary and base image must be released in lockstep or the pinned
  `FROM` becomes a support burden.
- **Unattended loops spend money.** No budget ceiling means a bad prompt can run N iterations of an
  Opus agent overnight.
