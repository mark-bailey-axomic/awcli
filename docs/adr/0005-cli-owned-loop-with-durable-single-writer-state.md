# ADR-0005: The CLI Owns The Loop; State Is Durable, Write-Through, And Single-Writer

**Date:** 2026-08-24
**Status:** Accepted
**Context:** [TDD](../../.atelier/design/agentic-workflow-cli-tdd.md)

## Decision

awcli invokes the workflow once per iteration and owns the loop. Shared state is written through to
durable storage as it changes, atomically, and is writable only from the workflow body.

Enforcing that takes two mechanisms rather than one, because the two ways a workflow leaves its body
have different shapes. `sandbox()` returns a scope, so the state it hands back is a read-only view
from the contract onwards and a write there does not compile. `agent()` returns a *result* rather
than a scope, so a fan-out branch is the body's own code holding the body's own context: there is no
child scope to hand a frozen view to, and a branch write is indistinguishable from a body write by
who made it. What separates them is *when* — awcli owns the loop, so it knows which agent calls are
outstanding, and a write made while an agent call the body started is still in flight is refused
(BR-012).

## Context

A workflow that loops internally can share state through ordinary closure variables, in which case a
state API is a pointless wrapper. State is only a real feature if it crosses a boundary — a
re-invocation, a restart, a crash. Agentic runs last hours and die halfway, so durability is the
reading worth having (grill Q3).

Two further facts forced the rest: parallel fan-out is the normal shape of these workflows, so a
mutable shared object is a data race; and an iteration that dies forty minutes in must not discard
what it recorded.

## Alternatives Considered

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **CLI loop, write-through, single-writer** | Resumable runs; a crash loses nothing recorded; lost updates become immediate errors | Workflows may observe mid-iteration state on resume; a legitimate record-as-you-go fan-out pattern needs results plumbed back | ✅ **Chosen** |
| Workflow-owned loop, in-memory state | Simplest, most flexible, matches how sandcastle workflows are written | No resumption; multi-hour runs restart from zero | ❌ Rejected |
| CLI loop, boundary flush only | Crisp semantics — disk always holds a clean boundary | A crash mid-iteration loses the pass unless the author remembered to flush | ❌ Rejected |
| Last-write-wins with a warning | Nothing blocked | A silent lost update surfacing hours later is the worst class of bug in an unattended run | ❌ Rejected |

## Decision Rationale

The single-writer rule cannot be enforced by a note in the docs, and that is the important half:
each violation has to become an immediate, located error naming the supported pattern. Where a
different capability *can* be handed out, it is — a `sandbox()` scope's read-only state is
structural, so that violation is a compile error and not a run-time one.

The fan-out half cannot be bought that way, and this ADR originally said it could. Freezing a child
view presumes a child scope, and `agent()` gives none: it hands back a result, which is what makes a
branch ordinary code inside the body rather than a separate permission context. A rule naming an
agent scope would name something the contract does not have. So the enforceable substitute is the
in-flight window, and it is deliberately blunt — awcli refuses a body write while any agent call
that body started is still running, whether or not anything was fanning out. That refuses some safe
writes. It is still the better trade: a refusal naming the pattern costs a line of rewriting, and a
lost update inside a fan-out is invisible and surfaces as inexplicably-wrong state hours later.

Write-through is affordable because the state is small JSON, and it converts "lost the iteration's
progress" from a certainty into a non-event.

## Consequences

### Positive
- A killed run resumes with everything it recorded.
- A lost update inside a fan-out is refused rather than silently taken.
- The loop is the natural home for iteration and time limits, and for spend accounting.

### Negative
- State must be storable as plain data — no live handles across iterations.
- Resumed workflows must tolerate partially-updated state.
- Recording progress from inside a fan-out requires returning results to the body.
- The two halves of the rule are enforced at different times and refuse at different sharpness. A
  write inside a `sandbox()` scope does not compile; a write during the in-flight window fails when
  it is made. Only the second reaches a reader as a run-time refusal, and only the second refuses
  writes that would have been safe — the window closes writes for the whole time any agent call the
  body started is outstanding, which is wider than "a branch is writing". Narrowing it would mean
  telling a branch write from a body write, and nothing in the contract distinguishes them.
- Reads are never refused, so a workflow can still observe state mid-fan-out and act on a value
  another branch is about to make stale. The rule is about lost writes, not about a consistent read.

### Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| State shape drifts from the workflow that wrote it | Med | Med | BR-009: opt-in declared shape validated on load, with a reset offered |
| Write-through churn on hot mutation | Low | Low | Debounced atomic writes; state is small |
| Torn state after a crash | High | Low | Temp-file-plus-rename; a partial write is never observable |

## Related

- **Rules:** BR-008, BR-009, BR-012, BR-017, BR-018, BR-023, BR-024, BR-037
