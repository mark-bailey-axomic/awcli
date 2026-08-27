# AWCLI-10 — [AWCLI] Enforce the single writer: read-only scope state, and no writes while agents run

**Points:** 2 · **Source:** WB-6 (part 2 of 2) · **Status:** Ready

## Problem / Goal

Single-writer state is easy to state and easy to violate: a workflow fanning out four parallel
agents will reach for shared state inside each branch and write it. Rather than documenting the
rule, awcli should refuse the violation — a branch sees state, cannot write it, and returns its
result to the body that can.

## Context

Single-writer state comes from ADR-0005, and enforcing it is what makes parallel fan-out safe
without locks inside the run. The pattern it pushes authors toward — branch returns a value, body
records it — is the one the approved scenarios describe.

**Two mechanisms, because the contract gives the two scopes different shapes.** `sandbox()` returns
a scope, and the contract frozen in AWCLI-01 types that scope's state as a deep read-only view, so a
write through it does not compile; this ticket adds the run-time refusal underneath the type, since
a type-only barrier is defeated by a cast. `agent()` returns a *result*, not a scope — so a fan-out
branch is the workflow body's own code holding the body's own context. There is nothing there to
freeze, and a branch write cannot be told from a body write by who made it.

What discriminates them is when, not who. BR-012 names that mechanism: shared state is writable
from the body only while the body has no agent call of its own still running. awcli owns the loop
(BR-017) and therefore already knows which agent calls are outstanding, so the window is a test it
can apply — and it is what this ticket builds. Nothing below presupposes an agent scope, because the
contract does not have one.

AWCLI-19 is what constructs the `sandbox()` scope — the working copy, the container, the child
context whose state is the read-only view — so the first mechanism here has nothing to attach to
until that lands. The dependency was invisible while the scope's construction was owned by
nothing; it is named now.

## Requirements

### Functional

- Present a readable but non-writable view of shared state inside a `sandbox()` scope, refused at
  run time and not only by the type.
- Refuse a write to shared state made while any agent call the workflow body started is still
  running, with a message naming the correct pattern (BR-012).
- Reopen writing as soon as the last such call has settled, so the body can record what its
  branches returned.
- Allow the workflow body to record values returned from its branches.

### Non-Functional

- The refusal is a clear, actionable error, not a silent no-op and not a type-only barrier.
- Reads are never refused: the window closes writes only, and reads inside a scope see a
  consistent snapshot for the life of that scope.
- No lock is required inside the run for parallel branches to read safely.
- Tracking outstanding calls costs nothing observable in a workflow that starts no agents.

## Constraints

- Enforcement is at run time, not by convention or documentation alone.
- The window is per workflow body and per run: it never observes the agents of a differently-named
  concurrent run (BR-011).
- The rule is stated as the window rather than as an agent scope, and no criterion here may
  presuppose a scope the frozen contract does not give (BR-033).

## Acceptance Criteria

- [ ] Scenario: *A parallel branch may read shared state but not write it*.
- [ ] Scenario: *A write while the body's own agents are still running is refused*.
- [ ] Scenario: *The workflow body records results returned from its branches*.
- [ ] A write made while an agent call is outstanding fails at run time with a message naming the
      return-value pattern; a write made after the last one settles succeeds immediately.
- [ ] A write through a `sandbox()` scope fails at run time as well as failing to compile, and
      nested `sandbox()` scopes stay read-only — the read-only view cannot be escaped by nesting.
- [ ] Reads succeed throughout, including while calls are outstanding.
- [ ] A concurrent run of a different name does not close this run's window.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- The parallel execution machinery itself — provided by workspaces (AWCLI-13) and drivers.
- Giving `agent()` a child context to freeze. That would be an addition to the frozen contract
  (BR-033), not this ticket, and BR-012 is deliberately written so nothing here needs one.

## Dependencies

**Blocked by:** AWCLI-02, AWCLI-09, AWCLI-19
**Blocks:** None
