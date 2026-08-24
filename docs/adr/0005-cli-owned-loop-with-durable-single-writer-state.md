# ADR-0005: The CLI Owns The Loop; State Is Durable, Write-Through, And Single-Writer

**Date:** 2026-08-24
**Status:** Accepted
**Context:** [TDD](../../.atelier/design/agentic-workflow-cli-tdd.md)

## Decision

awcli invokes the workflow once per iteration and owns the loop. Shared state is written through to
durable storage as it changes, atomically, and is writable only from the workflow body — child scopes
receive a frozen view.

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

Making the frozen view structural rather than documentary is the important half. The single-writer
rule cannot be enforced by a note in the docs; handing branches a different capability turns the
violation into an immediate, located error naming the supported pattern. Write-through is affordable
because the state is small JSON, and it converts "lost the iteration's progress" from a certainty
into a non-event.

## Consequences

### Positive
- A killed run resumes with everything it recorded.
- Lost updates are impossible rather than unlikely.
- The loop is the natural home for iteration and time limits, and for spend accounting.

### Negative
- State must be storable as plain data — no live handles across iterations.
- Resumed workflows must tolerate partially-updated state.
- Recording progress from inside a fan-out requires returning results to the body.

### Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| State shape drifts from the workflow that wrote it | Med | Med | BR-009: opt-in declared shape validated on load, with a reset offered |
| Write-through churn on hot mutation | Low | Low | Debounced atomic writes; state is small |
| Torn state after a crash | High | Low | Temp-file-plus-rename; a partial write is never observable |

## Related

- **Rules:** BR-008, BR-009, BR-012, BR-017, BR-018, BR-023, BR-024, BR-037
