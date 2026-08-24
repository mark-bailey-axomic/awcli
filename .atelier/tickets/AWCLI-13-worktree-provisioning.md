# AWCLI-13 — [AWCLI] Provision worktrees on deterministic branches

**Points:** 3 · **Source:** WB-8 (part 1 of 2) · **Status:** Ready

## Problem / Goal

An agent editing the operator's live checkout while they are working in it is the failure mode
that makes agentic tooling untrustworthy. Isolation must be the default, working on the live
checkout must require asking for it, and parallel agents must never share a working copy.

## Context

Workspace and execution are orthogonal axes (ADR-0003): a worktree is a workspace choice,
independent of whether execution happens on the host or in a container. Branch names are
deterministic so a resumed run can find what it made, and so an operator can recognise them.

## Requirements

### Functional

- Default to an isolated working copy per run, cut on a deterministic branch name.
- Require an explicit opt-in to work on the live checkout, and refuse to do so silently.
- Give each parallel slot its own working copy, so no two agents share one.
- Expose the current working copy's directory, branch, head and dirty state to the workflow.
- Register each working copy for release, with preservation of its branch.

### Non-Functional

- Branch names are derived from run name and slot, and are stable across runs of the same name.
- Provisioning a working copy costs a bounded amount of time and disk for a repository of
  ordinary size.
- Nothing is written to the operator's checkout when isolation is in effect.

## Constraints

- The workspace axis is independent of the execution axis — a worktree must work with host or
  container execution.
- Never delete or reset a working copy holding uncommitted changes as part of provisioning.

## Acceptance Criteria

- [ ] Scenario: *The default protects my checkout*.
- [ ] Scenario: *Working on the live checkout requires asking for it*.
- [ ] Scenario: *Parallel agents never share a working copy*.
- [ ] Branch names for the same run name and slot are identical across invocations.
- [ ] All tests pass, lint clean, type check clean.

## Out of Scope

- Reuse across iterations, resume and fresh start — AWCLI-14.
- Branch collection — AWCLI-22.

## Dependencies

**Blocked by:** AWCLI-03, AWCLI-07
**Blocks:** AWCLI-14, AWCLI-15, AWCLI-19, AWCLI-22
