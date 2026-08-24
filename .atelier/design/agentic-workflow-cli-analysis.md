---
feature: agentic-workflow-cli
artifact: architecture-analysis
status: Awaiting choice
date: 2026-08-24
---

# awcli — Architecture Alternatives

## What is actually open

The PRD and rules already fix a great deal: agents are subprocesses, TypeScript is loaded via a
bundled `tsx`, the context is injected, worktrees isolate, containers are opt-in, truth comes from
git and text. What remains open is **how the inside is composed** — and that choice is decided by
six hard parts, not by taste:

| Hard part | Rule | Why it discriminates |
|---|---|---|
| Cleanup on interrupt | BR-021 | Subprocesses, containers, worktrees, and a lock must unwind in order, on any exit path |
| Cancellation through a fan-out | BR-037, BR-021 | "Await in flight, then end" and "interrupt stops now" are different propagation semantics |
| Rehearsal as a first-class mode | BR-034, P0-13 | If it isn't a driver, it becomes `if (dryRun)` scattered through the codebase |
| Contract freeze without drift | BR-033 | A hand-authored `.d.ts` and a runtime implementation must be provably the same shape |
| Frozen state inside scopes | BR-012 | The context handed to a branch differs from the one handed to the body |
| Attributability | BR-025, BR-028 | Every log line and record belongs to a run, an iteration, and an agent |

## Cross-cutting finding — two axes, not three modes

Isolation is not a three-way choice. A container runs *against a worktree*; the two decisions are
independent:

- **Workspace** — the operator's live checkout, or a worktree on its own branch (the default).
- **Execution target** — the host, or a container.

`ctx.sandbox()` is therefore `worktree × container`, not a third mode. This applies to every option
below, and it is what lets BR-004 fail a container request without disturbing the workspace
decision.

---

## Option A — Functional core, driver ports, contract-first types *(recommended)*

Plain TypeScript, no framework. A small functional core (loop, state, validation, termination) with
explicit ports around every side effect:

```
AgentDriver      spawn an agent, stream its output          → claude | fake
ExecTarget       run a command somewhere                    → host | container
Workspace        provide a directory to work in             → liveTree | worktree
Store            durable state, run records, locks          → filesystem
Clock            time limits, timestamps                    → system | fixed
```

The context is assembled per iteration by a factory that closes over the ports; a child scope is the
same factory with a frozen state view. Cleanup is an explicit disposal stack unwound in reverse on
every exit path. The `.d.ts` is hand-authored as the contract and the runtime is checked against it
at compile time, so drift is a build error rather than a discovered surprise.

- **Buys:** every hard part has an obvious home. Rehearsal is `AgentDriver = fake`, not a flag.
  `Clock` makes time-limit behaviour testable without waiting. Ports are the seams the whole test
  strategy rests on, and P0-13 becomes achievable in week one.
- **Costs:** the disposal stack and cancellation propagation are hand-rolled, and hand-rolled
  unwinding is exactly where sandcastle needed a dedicated shutdown registry *even with* a framework
  helping it. Five ports is five interfaces to keep honest.

## Option B — Effect-based, as sandcastle is built

Typed errors in signatures, `Layer` for injection, `Scope` for resource lifetime, structured
concurrency for the fan-out.

- **Buys:** the two hardest parts are the framework's specialty. `Scope` makes "worktree and
  container released on every exit path" structural rather than remembered. Structured concurrency
  gives await-then-end and interrupt-now as different primitives instead of hand-written bookkeeping.
  Typed errors would make the refusal taxonomy (BR-001…009) exhaustive at compile time.
- **Costs:** it is the thing Q1 chose to walk away from. Every contributor — and every future you —
  pays the learning cost; stack traces and debugging get harder; and the public surface must be kept
  Effect-free anyway (sandcastle enforces this with a dedicated check script), so you carry the
  framework internally and hide it externally.

## Option C — Thin orchestrator, shell out inline

Minimal abstraction: small helpers over `git`, `docker`, and the agent CLI, called directly where
needed. No ports, no factory.

- **Buys:** the shortest path to a working `awcli run`. Nothing indirect, nothing to learn, every
  line does something visible.
- **Costs:** no seams. Rehearsal becomes conditionals threaded through the code rather than a driver,
  which undermines P0-13 — the one requirement whose entire purpose is to make the contract testable
  before the plumbing exists. Time limits can only be tested by waiting. Cleanup correctness rests on
  every call site remembering.

---

## Recommendation

**Option A.** Not because ports are elegant, but because P0-13 — freeze the contract, ship a fake
driver, author real workflows in week one — is *only* expressible if the agent is a port. Option C
cannot deliver it. Option B can, and would handle cleanup and cancellation better, but reintroduces
precisely the dependency the foundation decision removed, and would still need its public surface
kept framework-free.

The honest concession: A's weakest point is exactly B's strongest. Cleanup and cancellation are
hand-rolled, and that is where the real bugs will live. Mitigation is to make disposal a single
owned mechanism with its own tests from the first commit, rather than a convention observed at each
call site.
