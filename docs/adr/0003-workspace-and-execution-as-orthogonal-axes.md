# ADR-0003: Workspace And Execution Target Are Orthogonal, Not Three Isolation Modes

**Date:** 2026-08-24
**Status:** Accepted
**Context:** [TDD](../../.atelier/design/agentic-workflow-cli-tdd.md)

## Decision

Isolation is modelled as two independent axes — **workspace** (`liveTree | worktree`) and **execution
target** (`host | container`) — not as three isolation modes. `ctx.sandbox()` is the composition
`worktree × container`.

## Context

The PRD reads as three modes: live checkout, worktree, container. But a container also runs *against*
a worktree, so "container" is not a sibling of "worktree" — it is a different question about the same
run. Modelling them as three modes produces a switch whose branches share most of their behaviour and
drift apart over time.

BR-004 requires a container request to fail loudly rather than downgrade. That rule is only cleanly
expressible if the workspace decision is independent of the execution decision.

## Alternatives Considered

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **Two orthogonal axes** | Collapses combinatorics; BR-004 becomes a failure on one axis without touching the other; `liveTree × container` is excluded by construction | A slightly less literal reading of the PRD's wording | ✅ **Chosen** |
| **Three isolation modes** | Matches the PRD's prose directly | Three code paths sharing most behaviour; a container request failing has to decide what happens to the workspace | ❌ Rejected |

## Decision Rationale

| | Host process | Container process |
|---|---|---|
| **Live checkout** | explicit opt-in (BR-014) | excluded — no meaning |
| **Worktree** | the default | `ctx.sandbox()` |

The excluded cell is the point: mounting the operator's live checkout into a container combines the
weakest workspace guarantee with the strongest execution guarantee, which is confusing to explain and
of no practical use. Making it unrepresentable removes a case rather than documenting it.

## Consequences

### Positive
- Two small ports (`Workspace`, `ExecTarget`) instead of one large isolation abstraction.
- BR-004 is a failure to obtain an `ExecTarget`, with no workspace consequences.
- The default (worktree × host) needs no container support at all, preserving the no-Docker first run.

### Negative
- The word "sandbox" in the API no longer maps one-to-one to an internal type, so naming discipline
  (BR-015) must be maintained by review.

### Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Operators read "worktree" as a security boundary | High | High | BR-015: isolation level stated at every agent call; "sandbox" reserved for containers |
| A future remote execution target breaks the axis model | Low | Med | A remote target is another `ExecTarget`; the axis model is what makes that additive |

## Related

- **Rules:** BR-004, BR-013, BR-014, BR-015, BR-016
