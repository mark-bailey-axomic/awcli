# AWCLI-14 — [AWCLI] Reuse, resume and fresh start

**Points:** 3 · **Source:** WB-8 (part 2 of 2) · **Status:** Ready

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

This ticket also owns `ctx.git`, the whole of it. AWCLI-13 provisions a working copy and hands back a
handle carrying `dir`, `branch`, `head` and `dirty`, and constructs no context around one; `GitApi`
declares `log`, `diff` and `commit` besides, and until the 2026-08-28 `ctx.git` amendment in the
rules file those three were owned by no ticket while AWCLI-19, AWCLI-23 and AWCLI-25 all carried
criteria that consume them. WB-8's Contracts column names `ctx.git`, so the member was assigned and
the two tickets derived from the unit had between them narrowed it away. `supports()` answers per member (BR-033), so
a half-built `git` lies in one direction or the other — which is why the member is delivered by one
ticket rather than split again.

## Requirements

### Functional

- Reuse the same working copy across iterations of one run rather than reprovisioning.
- Expose the working copy's directory, branch, head and dirty state to the workflow as `ctx.git`.
- Build the rest of `ctx.git` with it — `log`, `diff` and `commit` — so the member is whole and
  `supports("git")` can answer true.
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
- [ ] `ctx.git` is built end to end — `dir`, `branch`, `head`, `dirty`, `log`, `diff` and `commit` —
      and `ctx.version.supports("git")` answers true, with the member's entry gone from
      `DELIVERED_BY` in `src/runtime/context.ts`.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- Collecting branches on request — AWCLI-22.
- Provisioning a working copy in the first place, and the refusals that guard it — AWCLI-13.

## Notes

Re-estimated 2 → 3 and widened to own `ctx.git` end to end by the 2026-08-28 `ctx.git` row of
the `## Amendments` section in [`../design/agentic-workflow-cli-rules.md`](../design/agentic-workflow-cli-rules.md).
No rule and no scenario changed: the gap was in what the two WB-8 tickets claimed, not in what the
specification states.

## Dependencies

**Blocked by:** AWCLI-13
**Blocks:** AWCLI-19, AWCLI-22, AWCLI-23, AWCLI-25

The three added here consume `ctx.git.dir` in their acceptance criteria — `ctx.sandbox()` resolving
to a scope whose `dir` differs from the body's (AWCLI-19), resolution against the directory `dir`
reports (AWCLI-23), a command's working directory being that same one (AWCLI-25) — and `ctx.git` is
this ticket's member end to end by the 2026-08-28 `ctx.git` amendment. They named AWCLI-13, which
builds the `WorkspaceHandle` and constructs no context around one, so the edge pointed at the ticket
that cannot discharge it. AWCLI-13 stays on their lists as well: it is where the provisioning they
also rest on lives, and the edge is transitive rather than wrong.
