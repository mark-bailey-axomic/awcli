# AWCLI-02 — [AWCLI] Ship the fake agent driver so workflows run with no agent installed

**Points:** 3 · **Source:** WB-1 (part 2 of 2) · **Status:** Ready

## Problem / Goal

Every downstream unit needs a way to exercise the orchestration without spending money or
waiting on a real agent, and an author needs to rehearse a workflow before trusting it with a
repository. A driver that fakes the agent — and only the agent — makes both possible on day
one.

## Context

The fake driver is the substitute behind the `AgentDriver` port; the rest of the run is real.
This is the enabler for contract-first development (PRD P0-13): the fake exists before the
Claude driver, so the loop, state and workspace units can all be built and tested against it.
Two rehearsal scenarios in the approved BDD set define the observable behaviour.

## Requirements

### Functional

- Provide a driver that satisfies the agent port without invoking any external agent.
- Return plausible results — commits, text output, isolation, log path — so consumers cannot
  tell the difference structurally.
- Support a dry-run mode that touches nothing real, and a rehearsal mode that still provisions
  a working copy so workspace behaviour can be observed.
- Make the fake selectable at run time without editing the workflow.

### Non-Functional

- Zero network calls and zero cost; safe to run in CI.
- Deterministic output, so tests built on it do not flake.
- Rehearsal must be visibly labelled in output and records — never mistakable for a real run.

## Constraints

- The fake substitutes the agent port only; workspace, state and record behaviour stay real.
- No branching on "am I fake?" inside the core — the substitution happens at the port boundary
  (ADR-0001).

## Acceptance Criteria

- [ ] Scenario: *A rehearsal is free and touches nothing real*.
- [ ] Scenario: *A rehearsal still creates a working copy*.
- [ ] A real workflow file can be authored and run end to end with no agent CLI installed.
- [ ] Records and terminal output mark a rehearsal distinctly from a real run.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- The real Claude driver (AWCLI-15) and structured output handling (AWCLI-17).
- Container execution (AWCLI-18, AWCLI-19).

## Dependencies

**Blocked by:** AWCLI-01
**Blocks:** AWCLI-10, AWCLI-15
