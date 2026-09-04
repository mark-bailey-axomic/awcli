# AWCLI-04 — [AWCLI] Two cancellation modes over one primitive

**Points:** 2 · **Source:** WB-2 (part 2 of 2) · **Status:** Ready

## Problem / Goal

Stopping a run means two different things. A workflow declaring itself done wants work already
in flight to finish; an operator pressing Ctrl-C wants everything to stop now. Both must be
expressions of a single cancellation primitive, or the two paths will drift and one of them
will leak.

## Context

Await-then-end and interrupt-now are the same signal with different drain policies. The
interrupt path is what makes an abandoned lock recoverable rather than permanent, and it pairs
with the stale-lock reclamation in AWCLI-07. Two approved scenarios pin the distinction.

## Requirements

### Functional

- Provide one cancellation signal, observable by every long-running operation.
- Support a drain mode that stops starting new work and awaits what is in flight.
- Support an immediate mode that abandons in-flight work and unwinds at once.
- Wire an operator interrupt to the immediate mode, and a workflow declaring completion to the
  drain mode.
- Make the signal available to workflow-visible operations so a long agent call is interruptible.

### Non-Functional

- A second interrupt during unwinding must escalate, not be ignored.
- State recorded before the interrupt survives it.
- Nothing is left locked after an interrupt.

## Constraints

- Do not add a second cancellation mechanism for containers or subprocesses; they observe this one.
- The drain mode must not wait on work the workflow never awaited.

## Acceptance Criteria

- [ ] Scenario: *Interrupting a run leaves nothing locked and loses nothing*.
- [ ] Scenario: *Interrupting is still the immediate stop*.
- [ ] Drain and immediate are shown to be modes of one primitive, not two code paths.
- [ ] A second interrupt during unwinding forces exit and says so.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- Awaiting in-flight agent fan-out on `done` — the loop-level behaviour is AWCLI-12.
- Agent process teardown specifics — AWCLI-16.

## Dependencies

**Blocked by:** AWCLI-03
**Blocks:** AWCLI-11, AWCLI-12, AWCLI-16

AWCLI-11 was missing from this line while naming AWCLI-04 as a blocker itself — the same omission
as AWCLI-01's, found the same way, by `verify-spec-invariants.sh` check 13a computing this line from
the other direction instead of trusting it.
