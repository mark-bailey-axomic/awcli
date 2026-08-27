# AWCLI-09 — [AWCLI] Persist shared state as it changes

**Points:** 3 · **Source:** WB-6 (part 1 of 2) · **Status:** Ready

## Problem / Goal

State shared across iterations is the reason the loop is worth running. If it is only flushed at
the end, a crash in iteration nine discards eight iterations of accumulated work. And a value
that cannot be stored must be rejected where it was set, not silently dropped at the boundary.

## Context

Write-through with atomic replacement is the durability half of ADR-0005. The declared-shape
export lets a workflow opt into validation when hydrating state written by an earlier version of
itself — otherwise a renamed field surfaces as a confusing failure many iterations later.

## Requirements

### Functional

- Persist state on change rather than at the end of the run.
- Replace the stored file atomically, so a partial write is never observable.
- Reject an unstorable value at the point of assignment, naming the offending path.
- Validate hydrated state against the workflow's declared shape when one is exported, and refuse
  clearly on mismatch.
- Support explicitly discarding stored state at the start of a run.

### Non-Functional

- A crash at any point leaves either the previous complete state or the new complete state.
- Validation is opt-in; a workflow that declares no shape pays nothing.
- Write cost stays proportional to change frequency, not to state size on every mutation path.

## Constraints

- One writer only — this unit assumes the exclusive lock is already held.
- All state lives under the single ignored runtime path.

## Acceptance Criteria

- [ ] Scenario: *A value that cannot be stored is rejected where it was set*.
- [ ] Scenario: *Stored state no longer matching the shape the workflow declares*.
- [ ] Scenario: *A crash mid-iteration does not discard what was recorded*.
- [ ] A partial write is never observable: an interrupted save leaves the previous state readable.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- Freezing state inside child scopes — AWCLI-10.
- Discarding worktrees alongside state on a fresh start — AWCLI-14.

## Dependencies

**Blocked by:** AWCLI-03, AWCLI-07
**Blocks:** AWCLI-10, AWCLI-11
