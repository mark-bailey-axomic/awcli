# AWCLI-17 — [AWCLI] Extract tagged results and re-ask narrowly once

**Points:** 3 · **Source:** WB-10 · **Status:** Ready

## Problem / Goal

A workflow that needs a decision from an agent — a plan, a verdict, a list — needs it as data.
When the agent's answer is malformed, redoing the work is wasteful and destructive: the commits
already exist. The right response is to ask again for the answer alone, once, and then give up on
the answer rather than the work.

## Context

Because commits come from git rather than from parsed output (ADR-0004), a malformed tag costs a
decision and not a night's work. That is what makes the narrow re-ask possible and what removed
the need to couple this unit to session resume.

## Requirements

### Functional

- Extract a result delimited by the requested tag from the agent's text output.
- Validate the extracted result against the schema the workflow supplied.
- On a malformed or missing result, re-ask once for the answer only, instructing the agent to
  change nothing.
- On a second malformed result, fail the iteration while preserving the work already done.
- Report which attempt produced the accepted result.

### Non-Functional

- Exactly one re-ask — no unbounded retry loop.
- The re-ask must be cheap relative to the original call.
- Extraction handles the tag appearing inside surrounding prose without being confused by it.

## Constraints

- Output is parsed as data and never evaluated.
- The re-ask must not be able to produce new commits; it asks for the answer, not the work.

## Acceptance Criteria

- [ ] Scenario: *A malformed result is re-asked for, not re-done*.
- [ ] Scenario: *A result that stays malformed costs the iteration, not the work*.
- [ ] The re-ask prompt explicitly instructs the agent to change nothing.
- [ ] A crafted output attempting to be executed rather than parsed is handled as inert data.
- [ ] Commits from the first attempt survive a failed second attempt.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- The gate refusing a tag the prompt never requests — AWCLI-06.

## Dependencies

**Blocked by:** AWCLI-15
**Blocks:** None
