# AWCLI-11 — [AWCLI] Drive iterations and classify how a run ends

**Points:** 3 · **Source:** WB-7 (part 1 of 2) · **Status:** Ready

## Problem / Goal

The tool owns the loop, not the workflow — that is what lets state survive across passes and
what lets a scheduler read an outcome. A run ends in one of four ways, and conflating "finished
the work" with "ran out of iterations" makes overnight automation unactionable.

## Context

Loop ownership and the four terminal states are ADR-0005 and PRD P0-3. The subtlety is that
exhausting a limit means different things to different workflows: a task workflow ran out of
road, a monitor workflow did exactly its job. The workflow declares which it is, and the exit
code follows that declaration.

## Requirements

### Functional

- Invoke the workflow's default export once per iteration, carrying state across passes.
- End on the workflow declaring itself done, and report that as finished.
- End on iteration limit and on duration limit, each independently.
- Treat an exhausted limit as incomplete by default, and as finished when the workflow declares
  exhaustion to be completion.
- Map each terminal classification to its reserved exit code.

### Non-Functional

- The duration limit is honoured even when the iteration count would not have ended the run.
- The terminal classification appears in the record and on the terminal, in the same words.
- Loop overhead per iteration stays negligible next to agent time.

## Constraints

- The workflow may not own the loop — a workflow body that loops internally is outside this design.
- The four terminal states are exhaustive; no fifth outcome may be introduced.

## Acceptance Criteria

- [ ] Scenario: *The tool drives the loop and carries state across passes*.
- [ ] Scenario: *Finishing the work early is reported as finished*.
- [ ] Scenario: *Exhausting the iterations is incomplete unless the workflow says otherwise*.
- [ ] Scenario: *A monitor-style workflow declares that exhausting its limits is expected*.
- [ ] Scenario: *The time limit ends a run the iteration count would not have*.
- [ ] Each classification exits with its reserved code.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- Per-iteration failure isolation and the in-flight drain on `done` — AWCLI-12.
- Resume and fresh-start semantics — AWCLI-14.

## Dependencies

**Blocked by:** AWCLI-04, AWCLI-09
**Blocks:** AWCLI-12
