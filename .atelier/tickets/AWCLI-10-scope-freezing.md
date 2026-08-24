# AWCLI-10 — [AWCLI] Freeze state inside agent and container scopes

**Points:** 2 · **Source:** WB-6 (part 2 of 2) · **Status:** Ready

## Problem / Goal

Single-writer state is easy to state and easy to violate: a workflow fanning out four parallel
agents will reach for shared state inside each branch and write it. Rather than documenting the
rule, the API should make the violation impossible — a branch sees state, cannot write it, and
returns its result to the body that can.

## Context

The frozen view is a structural enforcement of the single-writer property from ADR-0005, and it
is what makes parallel fan-out safe without locks inside the run. The pattern it pushes authors
toward — branch returns a value, body records it — is the one the approved scenarios describe.

## Requirements

### Functional

- Present a readable but non-writable view of shared state inside any child scope.
- Fail a write attempt inside a scope with a message naming the correct pattern.
- Allow the workflow body to record values returned from its branches.
- Apply the same freezing to agent scopes and container scopes alike.

### Non-Functional

- The refusal is a clear, actionable error, not a silent no-op or a type-only barrier.
- Reads inside a scope see a consistent snapshot for the life of that scope.
- No lock is required inside the run for parallel branches to read safely.

## Constraints

- Freezing is enforced at run time, not by convention or documentation alone.
- The body's own access is unaffected — it remains the single writer.

## Acceptance Criteria

- [ ] Scenario: *A parallel branch may read shared state but not write it*.
- [ ] Scenario: *The workflow body records results returned from its branches*.
- [ ] A write inside a scope fails at run time with a message naming the return-value pattern.
- [ ] Nested scopes remain frozen; freezing cannot be escaped by nesting.
- [ ] All tests pass, lint clean, type check clean.

## Out of Scope

- The parallel execution machinery itself — provided by workspaces (AWCLI-13) and drivers.

## Dependencies

**Blocked by:** AWCLI-02, AWCLI-09
**Blocks:** None
