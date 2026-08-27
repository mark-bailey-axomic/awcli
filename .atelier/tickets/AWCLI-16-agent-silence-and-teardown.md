# AWCLI-16 — [AWCLI] Handle silence, lingering processes and unreadable detail

**Points:** 2 · **Source:** WB-9 (part 2 of 2) · **Status:** Ready

## Problem / Goal

Three ways a subprocess agent misbehaves each need a different answer. One goes quiet and never
returns — that iteration must fail rather than hang the night. One finishes its work but never
exits — that is a success with a cleanup problem, not a failure. One emits detail the tool cannot
parse — the run continues on git and text, but the operator must be told once, loudly.

## Context

These three behaviours were observed as real costs in the reference implementation, which is
why they are pinned as rules rather than left to discovery. The degradation rule follows from
ADR-0004: if the stream is enrichment, losing it is a warning, not a failure.

## Requirements

### Functional

- Fail an iteration when the agent produces no output for longer than the configured idle limit.
- Treat an agent that has completed its work but not exited as successful, and tear it down.
- Warn once when structured detail cannot be read, naming the field, and continue on git and text.
- Ensure teardown reaches child processes, not only the immediate subprocess.

### Non-Functional

- Idle detection measures silence, not total duration — a slow but talking agent is not killed.
- The degradation warning appears once per run per field, not once per iteration.
- Teardown completes within a bounded time and reports a process it could not stop.

## Constraints

- Teardown behaviour is isolated behind one module, so the non-POSIX path stays viable (ADR-0007).
- A lingering process must never be reclassified as a failure just because it did not exit.

## Acceptance Criteria

- [ ] Scenario: *An agent that goes silent fails its iteration*.
- [ ] Scenario: *An agent that finished but has not exited is treated as successful*.
- [ ] Scenario: *Detail that cannot be read degrades once and loudly*.
- [ ] A talkative agent running longer than the idle limit is not killed.
- [ ] Teardown reaches grandchild processes; a survivor is reported.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- Run-level duration limits — AWCLI-11.

## Dependencies

**Blocked by:** AWCLI-04, AWCLI-15
**Blocks:** None
