# AWCLI-21 — [AWCLI] Per-agent logs, honest isolation reporting, and spend with a threshold

**Points:** 3 · **Source:** WB-13 · **Status:** Ready

## Problem / Goal

Four agents streaming into one terminal is unreadable, and unreadable output is the same as no
output. Each agent needs its own log and a summarised terminal view. Two related honesty
problems ride along: every call must state how isolated it actually was, and spend must be
reported without a threshold quietly passing because the number was never measurable.

## Context

Reporting spend rather than enforcing a budget is the v1 scope decision (PRD P1). The subtlety is
that spend can be unknown — the agent's stream may not supply it — and a threshold that cannot be
measured must say so up front rather than never firing. Isolation reporting closes the gap where
an operator assumes containment they did not get.

## Requirements

### Functional

- Write a separate log per agent call, addressable from the run record.
- Keep the terminal readable under parallel fan-out: progress and summaries, not interleaved
  streams.
- State the isolation actually in effect for every agent call — workspace axis and execution axis.
- State the run's own workspace choice in the run's output, not only per agent call: an operator who
  asked for their live checkout sees that they got it, and one who did not sees that they did not
  (BR-014, BR-015). This is the sentence `WorkspaceIsolation.description` already carries and that
  nothing yet prints.
- Report spend per iteration and per run, marking unknown values as unknown.
- Warn when a configured spend threshold is crossed, and warn at the start of the run when the
  threshold cannot be measured at all.
- Redact values matching known secret shapes from logs as well as records.
- Write a log field that cannot be written down as plain data as unrepresentable, naming the
  field, and keep both the line and the run (BR-008). The check is at the point the line is
  serialised, because a log field's type no longer refuses one at the call site — and it must
  not: a command's result, a commit and the run's arguments are awcli's own shapes and are the
  ordinary things to log.

### Non-Functional

- An unknown spend never reads as zero, and never satisfies a threshold by default.
- The terminal remains readable with at least four concurrent agents.
- Log writing must not become the bottleneck under fan-out.

## Constraints

- Isolation is reported from what actually happened, never from what was requested.
- The unmeasurable-threshold warning fires once, at the start, not at the end.

## Acceptance Criteria

- [ ] Scenario: *Four agents at once stay readable*.
- [ ] Scenario: *Every agent call states how isolated it is*.
- [ ] Scenario: *Spend is reported and a threshold warns*.
- [ ] Scenario: *A threshold that cannot be measured says so up front*.
- [ ] Scenario: *A log field that cannot be written down costs the field, not the run*.
- [ ] A command's result, a commit and the run's arguments each log without being restated by
      hand — asserted against the contract's own types, not against a hand-built object.
- [ ] Values matching known secret shapes are absent from logs.
- [ ] The run's output states the workspace choice it resolved to, in both directions — this is the
      fourth step of the scenario `Working on the live checkout requires asking for it`, which
      AWCLI-13 carries and cannot tick without this ticket and AWCLI-20.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- Enforcing a budget by stopping a run — deferred past v1.
- Resolving the workspace choice, and parsing the flag that asks for it — AWCLI-13 and AWCLI-20
  respectively. This ticket states what was resolved and never decides it (see the constraint
  above: isolation is reported from what actually happened).

## Dependencies

**Blocked by:** AWCLI-07, AWCLI-08, AWCLI-15
**Blocks:** None
