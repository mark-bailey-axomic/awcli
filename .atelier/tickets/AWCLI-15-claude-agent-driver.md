# AWCLI-15 — [AWCLI] Run the agent as a subprocess and read its results from git and text

**Points:** 3 · **Source:** WB-9 (part 1 of 2) · **Status:** Ready

## Problem / Goal

The agent is an external CLI that can change under the tool at any time. Depending on its
structured event stream for anything load-bearing means a version bump silently breaks runs. The
driver must take commits from the repository and results from text, so the agent's stream is
enrichment rather than a dependency.

## Context

Git and text as source of truth is ADR-0004, and the reason this design survives agent updates.
The driver satisfies the agent port already exercised by the fake (AWCLI-02), so the loop, state
and workspace units are already proven against the same interface.

## Requirements

### Functional

- Start the agent as a subprocess in the current working copy and execution target.
- Stream its output incrementally, so a long call is observable while it runs.
- Read commits produced by an agent call from the repository, not from parsed output.
- Return a result carrying commits, text output, isolation, log path, and spend where known.
- Work against an agent invoked with no structured output mode at all.

### Non-Functional

- No load-bearing behaviour depends on the shape of the agent's event stream.
- A field the stream does not supply is reported as unknown, never as a default value.
- Credentials reach the agent by environment or mount, never on a command line.

## Constraints

- The subprocess is registered with the disposal stack at spawn, not after it succeeds.
- Output is treated as data throughout — never evaluated.

## Acceptance Criteria

- [ ] Commits attributed to an agent call are read from the repository, verified against a call
      that produces commits without mentioning them in its output.
- [ ] The driver produces a usable result with the agent's structured output mode disabled.
- [ ] Spend absent from the stream is reported as unknown, and does not read as zero.
- [ ] The subprocess is released on normal end, failure and interrupt.
- [ ] All tests pass, lint clean, type check clean.

## Out of Scope

- Silence, lingering processes and stream degradation — AWCLI-16.
- Tagged output extraction and validation — AWCLI-17.

## Dependencies

**Blocked by:** AWCLI-01, AWCLI-02, AWCLI-13
**Blocks:** AWCLI-16, AWCLI-17, AWCLI-21
