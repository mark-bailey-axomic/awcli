# AWCLI-12 — [AWCLI] Isolate per-iteration failure and drain in-flight work on done

**Points:** 2 · **Source:** WB-7 (part 2 of 2) · **Status:** Ready

## Problem / Goal

An overnight run of twenty iterations should not be ended by one flaky agent call. But a run
where nothing ever succeeded is a failure, not a success, and a precondition that cannot hold
should stop the loop immediately rather than fail nineteen more times. Separately, a workflow
that declares itself done while four agents are still running must not abandon their work.

## Context

Three approved scenarios distinguish tolerable failure from terminal failure, and one more pins
the drain behaviour on `done` — a rule that only surfaced while writing the scenarios. The drain
reuses the cancellation primitive rather than introducing a second mechanism.

## Requirements

### Functional

- Catch a failure inside one iteration, record it, and continue to the next.
- Classify a run in which no iteration succeeded as failed.
- Stop the loop immediately when a failure is a precondition failure rather than a transient one.
- On a workflow declaring itself done, stop starting new work and await work already in flight
  before ending.
- Report per-iteration failures in the record and in the summary, with counts.

### Non-Functional

- A tolerated failure must be visible; a quiet retry that hides a systematic problem is a defect.
- The drain must not wait indefinitely — a bounded wait, then escalate to immediate.
- Distinguish tolerable from terminal failure by classification, not by string matching.

## Constraints

- Only one cancellation primitive; drain is a mode of it, not new machinery.
- Interrupt remains the immediate stop and is unaffected by drain behaviour.

## Acceptance Criteria

- [ ] Scenario: *One bad iteration does not end the night*.
- [ ] Scenario: *A run where nothing succeeded is a failed run*.
- [ ] Scenario: *A precondition failure stops the loop immediately*.
- [ ] Scenario: *Declaring done lets work already in flight finish*.
- [ ] The summary reports how many iterations failed and why.
- [ ] All tests pass, lint clean, type check clean.

## Out of Scope

- Agent-level timeout and teardown — AWCLI-16.

## Dependencies

**Blocked by:** AWCLI-04, AWCLI-11
**Blocks:** None
