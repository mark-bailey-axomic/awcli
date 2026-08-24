# ADR-0001: Plain TypeScript With Driver Ports, Not an Effect Runtime

**Date:** 2026-08-24
**Status:** Accepted
**Context:** [TDD](../../.atelier/design/agentic-workflow-cli-tdd.md), [analysis](../../.atelier/design/agentic-workflow-cli-analysis.md)

## Decision

awcli is written in plain TypeScript with a functional core and five explicit driver ports —
`AgentDriver`, `ExecTarget`, `Workspace`, `Store`, `Clock` — rather than on an Effect runtime.

## Context

awcli orchestrates subprocesses, containers, git worktrees, and durable state, and must unwind all
of them on any exit path (BR-021). Sandcastle, the reference implementation, is built on Effect and
uses `Scope` for exactly this. Rebuilding from scratch (grill Q1) reopened the choice.

The deciding requirement is P0-13: freeze the context contract and ship a fake agent driver so real
workflows can be authored in week one, before orchestration exists. That is only expressible if the
agent is a replaceable port.

## Alternatives Considered

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **Plain TS + ports** | Every hard part has an obvious home; rehearsal is a driver, not a flag; `Clock` makes time limits testable without waiting; no learning cost | Disposal and cancellation are hand-rolled — the known weak spot | ✅ **Chosen** — the only option that delivers P0-13 without a framework dependency |
| **Effect runtime** | `Scope` makes cleanup structural; structured concurrency gives await-then-end and interrupt-now as primitives; typed errors make the refusal taxonomy exhaustive | Reintroduces the dependency Q1 removed; learning and debugging cost; public surface must be kept Effect-free anyway | ❌ Rejected — its strengths are real but bought with the exact coupling the foundation decision removed |
| **Thin orchestrator, no ports** | Shortest path to a working `awcli run` | No seams: rehearsal becomes scattered conditionals, defeating P0-13; time limits testable only by waiting | ❌ Rejected — cannot satisfy P0-13 |

## Decision Rationale

Ports are not chosen for elegance. They are chosen because the *test and authoring strategy* depends
on substitution: a fake `AgentDriver` gives free authoring and free tests; a fixed `Clock` gives
time-limit tests that finish instantly; an `ExecTarget` makes "host or container" a value rather than
a branch. Effect would handle cleanup better, but sandcastle needed a dedicated shutdown registry
*even with* `Scope`, which suggests the framework reduces rather than removes that work.

## Consequences

### Positive
- Rehearsal (BR-034) and the fake driver (P0-13) are the same mechanism.
- Contract-first development is possible: ports can be stubbed before they are implemented.
- No framework in the public surface, so no enforcement script is needed to keep it out.

### Negative
- Disposal ordering, cancellation propagation, and await-then-end (BR-037) are all hand-written.
- Five interfaces must be kept honest as the implementation grows.

### Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Leaked containers, worktrees, or locks on an unusual exit path | High | Med | Disposal is a single owned mechanism (WB-2), built and tested before anything registers with it — not a convention followed at each call site |
| Cancellation semantics drift between interrupt and declared-done | Med | Med | One cancellation primitive with both semantics expressed as parameters, covered by the BR-021 and BR-037 scenarios |
| Port count grows until injection is unwieldy | Low | Low | Five is the cap for v1; a sixth port needs a reason recorded here |

## Implementation Notes

The functional core takes ports as arguments and returns decisions; side effects happen only in port
implementations. The context object is assembled per iteration by a factory closing over the ports,
which is also how a child scope gets a frozen state view (BR-012) — same factory, different state
capability.

## Related

- **TDD:** [agentic-workflow-cli-tdd.md](../../.atelier/design/agentic-workflow-cli-tdd.md)
- **Rules:** BR-012, BR-021, BR-033, BR-034, BR-037
