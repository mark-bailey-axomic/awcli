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

## Requirements

### Functional

- Refuse native Windows at startup, naming the supported route forward.
- Refuse a target directory that is not a repository.
- Compare the running version against the repository's declared range: refuse below it, proceed
  within it, and accept any version when nothing is declared.
- Refuse when the workflow needs a profile fact the repository does not provide, naming the field.
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
- [ ] Scenario: *The free-form part of a profile carries no guarantee*.
- [ ] Scenario: *Asking for tagged output the prompt never requests*.
- [ ] A test asserts no side effect occurs before any refusal.
- [ ] All tests pass, lint clean, type check clean.

## Out of Scope

- The container-availability refusal — it belongs with the container target (AWCLI-19).
- Lock contention refusal — AWCLI-07.

## Dependencies

**Blocked by:** AWCLI-05
**Blocks:** None
