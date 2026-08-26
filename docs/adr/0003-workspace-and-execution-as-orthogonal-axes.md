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
| **Two orthogonal axes** | Collapses combinatorics; BR-004 becomes a failure on one axis without touching the other; nothing awcli composes is `liveTree × container` | A slightly less literal reading of the PRD's wording; two independent fields can still *name* the excluded cell, so it is ruled out by what awcli builds rather than by the type | ✅ **Chosen** |
| **Three isolation modes** | Matches the PRD's prose directly | Three code paths sharing most behaviour; a container request failing has to decide what happens to the workspace | ❌ Rejected |

## Decision Rationale

| | Host process | Container process |
|---|---|---|
| **Live checkout** | explicit opt-in (BR-014) | excluded — no meaning |
| **Worktree** | the default | `ctx.sandbox()` |

The excluded cell is the point: mounting the operator's live checkout into a container combines the
weakest workspace guarantee with the strongest execution guarantee, which is confusing to explain and
of no practical use. awcli never composes it — `sandbox()` fixes `worktree × container`, and the live
checkout only ever runs on the host — so the cell is a case that does not exist rather than a case
that is documented and refused. What the published type does not do is refuse to *name* it:
`Isolation` carries the two axes as independent fields, so a value describing the excluded cell can be
written down even though nothing produces one.

## Consequences

### Positive
- Two small ports (`Workspace`, `ExecTarget`) instead of one large isolation abstraction.
- BR-004 is a failure to obtain an `ExecTarget`, with no workspace consequences.
- The default (worktree × host) needs no container support at all, preserving the no-Docker first run.

### Negative
- The word "sandbox" in the API no longer maps one-to-one to an internal type, so naming discipline
  (BR-015) must be maintained by review.
- The exclusion is a property of what awcli produces, not of what the type can express. `sandbox()`
  fixes `worktree × container` and the live checkout only ever runs on the host, but `Isolation`'s two
  independent fields can name `liveTree × container` — the reporting type admits a value nothing
  composes. Closing it would mean replacing the two fields with a single three-member union, a change
  to the published surface and therefore possible only before the v1 freeze. It was declined: one union
  takes away the orthogonality this ADR chose the model for, since BR-004 as a failure on one axis
  without touching the other is exactly what a single union collapses.

### Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Operators read "worktree" as a security boundary | High | High | BR-015: isolation level stated at every agent call; "sandbox" reserved for containers |
| A future remote execution target breaks the axis model | Low | Med | A remote target is another `ExecTarget`; the axis model is what makes that additive |

## Related

- **Rules:** BR-004, BR-013, BR-014, BR-015, BR-016
