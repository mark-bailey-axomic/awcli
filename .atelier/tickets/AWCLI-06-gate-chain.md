# AWCLI-06 — [AWCLI] Refuse a run before any side effect

**Points:** 3 · **Source:** WB-4 · **Status:** Ready

## Problem / Goal

A run that is going to be refused should be refused before it costs anything — before a
container is built, a worktree is cut, or an agent is paid for. Six separate refusals share one
property: each is knowable from configuration and the loaded workflow alone.

## Context

The gates are ordered cheapest-first, and the platform gate is first of all: native Windows is
refused with WSL2 named as the route forward (ADR-0007). The version gate reads a declared
range so a semver major is the breaking-change signal. The profile gate is the seam that lets a
portable workflow state what it needs from a repository and fail clearly when it is absent.

**The profile gate is unconditional, which is wider than it first reads.** BR-006 makes every
profile field awcli defines required in a repository's configuration, so the gate checks the
configuration against that fixed set rather than against what the loaded workflow happens to
reach for. A repository missing a field is refused whether or not this run would have read it,
and before the lock or any working copy. The reason is portability: a workflow is refused on the
repository that cannot support it, not on the one iteration that first touches the gap — and an
operator who fixes the configuration once has fixed it for every workflow. `awcli init` writes
all five fields (AWCLI-22), so an initialised repository passes this gate as initialised.

## Requirements

### Functional

- Refuse native Windows at startup, naming the supported route forward.
- Refuse a target directory that is not a repository.
- Compare the running version against the repository's declared range: refuse below it, proceed
  within it, and accept any version when nothing is declared.
- Refuse when the repository's configuration lacks any profile field awcli defines, naming each
  field it lacks — whether or not the loaded workflow reads it, and before the lock or any working
  copy (BR-006).
- Treat the free-form part of a profile as carrying no guarantee — reading it is the workflow's risk.
- Refuse a request for tagged output when the prompt never asks for that tag.

### Non-Functional

- Every refusal names the cause and, where one exists, the route forward.
- Refusals exit with the reserved refusal code, distinct from failure and from incomplete.
- No container, worktree, lock or agent work precedes any refusal.

## Constraints

- Gates run cheapest-first; a later, more expensive gate may not run before an earlier one.
- A missing declared range means "any version" — silence is permission, not refusal.

## Acceptance Criteria

- [ ] Scenario: *Native Windows is refused with a route forward*.
- [ ] Scenario: *A directory that is not a repository is refused*.
- [ ] Scenarios: *An awcli older than the repository requires is refused*, *An awcli within the
      required range proceeds*, *A repository that requires nothing accepts any version*.
- [ ] Scenario: *A portable workflow meeting a repository that lacks a fact it needs*.
- [ ] Scenario: *A missing profile field is refused even when no workflow reads it*.
- [ ] Scenario: *The free-form part of a profile carries no guarantee*.
- [ ] Scenario: *Asking for tagged output the prompt never requests*.
- [ ] The profile gate is driven by awcli's fixed field set, not by what the loaded workflow
      reads — asserted with a workflow that reads none of them.
- [ ] A configuration missing more than one field is refused naming every one of them, not just
      the first.
- [ ] A test asserts no side effect occurs before any refusal.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- The container-availability refusal — it belongs with the container target (AWCLI-19).
- Lock contention refusal — AWCLI-07.

## Dependencies

**Blocked by:** AWCLI-05
**Blocks:** None
