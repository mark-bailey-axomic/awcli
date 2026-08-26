# AWCLI-03 — [AWCLI] Build the disposal stack before anything registers with it

**Points:** 3 · **Source:** WB-2 (part 1 of 2) · **Status:** Done

## Problem / Goal

Runs acquire locks, worktrees, containers and child processes. If any of those outlive a failed
or interrupted run, the next run is blocked by a lock nobody holds or a worktree nobody owns.
Cleanup cannot be retrofitted — it has to exist before the first resource is acquired.

## Context

Resource unwinding is a spine every later unit registers with: the lock (AWCLI-07), worktrees
(AWCLI-13), containers (AWCLI-19) and agent subprocesses (AWCLI-14). Building it first is a
deliberate ordering choice in the work breakdown; nothing downstream may acquire a resource
before this exists.

## Requirements

### Functional

- Register a resource with its release action at acquisition time, as one step.
- Unwind in reverse order of acquisition on every exit path: normal end, failure, interrupt,
  and a throw from the workflow body.
- Continue unwinding after a release action itself fails, and report every failure rather than
  the first.
- Support release-with-preservation, so a resource can be let go without destroying what it
  holds.

### Non-Functional

- A resource that is never released must fail a test, not be discovered in production.
- Unwinding must complete within a bounded time; a hung release cannot hang the exit forever.
- No unhandled rejection may escape the unwind path.

## Constraints

- Nothing may register a resource before the stack exists — this unit lands before its consumers.
- The stack is part of the functional core's boundary, not spread through call sites (ADR-0001).

## Acceptance Criteria

- [x] Resources unwind in reverse on normal end, on failure, and on a throw from the workflow body.
- [x] A failing release does not prevent the remaining releases; all failures are reported.
- [x] A test asserts that no resource is leaked after each exit path, and fails when one is.
- [x] A release that never returns is abandoned after a bounded wait, and that is reported.
- [x] All tests pass, lint clean, type check clean.

## Out of Scope

- Signal handling and the two cancellation modes — AWCLI-04.
- The concrete resources themselves.

## Dependencies

**Blocked by:** AWCLI-00
**Parallel with:** AWCLI-01 — neither depends on the other.
**Blocks:** AWCLI-04, AWCLI-07, AWCLI-09, AWCLI-13, AWCLI-19
