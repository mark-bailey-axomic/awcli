# AWCLI-14 — [AWCLI] Reuse, resume and fresh start

**Points:** 2 · **Source:** WB-8 (part 2 of 2) · **Status:** Ready

## Problem / Goal

A twenty-iteration run that cuts a new branch every pass produces twenty branches and loses all
continuity. Resuming a named run must reattach the branch it already had, restore the state it
had accumulated, and say plainly what it inherited — because silently inheriting yesterday's
half-finished work is how an operator loses an afternoon.

## Context

Reuse across iterations and resume across invocations are the same mechanism seen at two time
scales. Fresh start is the escape hatch, and it must discard state and working copies together —
discarding one without the other leaves an inconsistent run. Branches outlive their run by design
(ADR-0004): the commits are the deliverable.

## Requirements

### Functional

- Reuse the same working copy across iterations of one run rather than reprovisioning.
- On resume of a named run, reattach the existing branch and working copy.
- Report what a resumed run inherited: branch, head, iteration count and state summary.
- On an explicit fresh start, discard stored state and working copies together.
- Never delete a branch automatically at the end of a run.

### Non-Functional

- Inheritance is always reported, never assumed silently.
- Fresh start is all-or-nothing: no run begins with state from one source and a working copy
  from another.
- Resume works after an abnormal termination, not only after a clean end.

## Constraints

- Branches are never auto-deleted, even on fresh start — the working copy goes, the commits stay.
- Uncommitted changes in a reattached working copy are reported, not discarded.

## Acceptance Criteria

- [ ] Scenario: *Resuming a run reattaches the branch it already had*.
- [ ] Scenario: *Resuming restores the work and says what it inherited*.
- [ ] Scenario: *Starting fresh discards state and working copies together*.
- [ ] Scenario: *Branches survive the run that made them*.
- [ ] A resumed run after a kill reattaches successfully.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- Collecting branches on request — AWCLI-22.

## Dependencies

**Blocked by:** AWCLI-13
**Blocks:** AWCLI-22
