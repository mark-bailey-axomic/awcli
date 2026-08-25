# AWCLI-19 — [AWCLI] Execute agents in a container with credentials lent, never baked

**Points:** 2 · **Source:** WB-11 (part 2 of 2) · **Status:** Ready

## Problem / Goal

A workflow that asks for a container is asking for a containment guarantee. Quietly falling back
to host execution when the daemon is unavailable would break that guarantee at the worst moment.
And credentials must be lent to a container for the life of a call, never baked into an image
that could be pushed or shared.

## Context

Workspace and execution are orthogonal axes (ADR-0003), so the execution axis can fail without
disturbing the workspace axis — a container refusal does not affect a workflow that never asked
for one. This is the second half of the container work; the image itself comes from AWCLI-18.

**This ticket is the container target only.** Every requirement below is about running in the
container. The default target — a command run on the host, with the operator's own reach — is
AWCLI-25, governed by BR-040. A container is the only thing that changes what a command can reach
(BR-015), which is what makes this the opt-in half rather than the whole of `ctx.exec`.

## Requirements

### Functional

- Run a command or an agent inside the container, in the current working copy.
- Refuse the run when a container was requested and the runtime is unavailable — never downgrade
  silently.
- Leave a workflow that requested no container entirely unaffected by an absent runtime.
- Mount credentials read-only for the duration of a call, and release them with the container.
- Report per call which isolation was actually in effect.

### Non-Functional

- The refusal is a refusal, with the reserved refusal exit code and a named cause.
- No credential value appears in the image, in a command line, or in any record or log.
- Container availability is probed once per run, not once per call.

## Constraints

- Host path to container path mapping is isolated behind one module, so the non-POSIX path
  stays viable (ADR-0007).
- The container is registered with the disposal stack at creation.

## Acceptance Criteria

- [ ] Scenario: *A requested container is never silently downgraded*.
- [ ] Scenario: *A workflow that asks for no container is unaffected by its absence*.
- [ ] Scenario: *Credentials are lent to a container, never baked into it*.
- [ ] An inspection of the built image finds no credential material.
- [ ] The container is removed on normal end, on failure and on interrupt.
- [ ] All tests pass, lint clean, type check clean.

## Out of Scope

- Image generation and build caching — AWCLI-18.
- Per-call isolation reporting format — AWCLI-21.
- Command execution on the host target, and what BR-040 says a command reaches there — AWCLI-25.

## Dependencies

**Blocked by:** AWCLI-03, AWCLI-13, AWCLI-18
**Blocks:** None
