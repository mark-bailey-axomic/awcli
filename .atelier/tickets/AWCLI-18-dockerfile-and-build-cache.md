# AWCLI-18 — [AWCLI] Generate a self-contained Dockerfile and build it on demand

**Points:** 3 · **Source:** WB-11 (part 1 of 2) · **Status:** Ready

## Problem / Goal

Container execution needs an image, and the operator needs to own it — a repository that needs an
unusual toolchain must be able to edit its own Dockerfile without waiting on a tool release. That
means generating a self-contained, committed Dockerfile and rebuilding only when its content
actually changes.

## Context

No published base image (ADR-0006): the generated Dockerfile stands alone, so the tool ships one
artifact rather than two that must stay in version lockstep. The layer cache is per-daemon, so
repositories sharing an identical prelude share cached layers — the real rebuild costs are a
different base image, a second machine, an edit above the install line, or a prune.

## Requirements

### Functional

- Generate a self-contained Dockerfile into the repository on initialisation, committed and
  operator-editable.
- Build the image on demand, keyed on the Dockerfile's content, and reuse it when unchanged.
- Rebuild when and only when the Dockerfile's content changes.
- Report the image and its provenance in the diagnostic command.
- Allow the operator to force a rebuild explicitly.

### Non-Functional

- No dependency on any published base image owned by this tool.
- A repeated run with an unchanged Dockerfile performs no build work.
- The build's output is surfaced on failure, with the failing instruction identified.

## Constraints

- The Dockerfile is operator-owned: regeneration never silently overwrites operator edits.
- A stable install instruction can pin a stale agent version in cache — the diagnostic command
  must make the cached agent version visible so this is diagnosable.

## Acceptance Criteria

- [ ] A rebuild happens only when the Dockerfile's content changes; an unchanged run performs no
      build.
- [ ] Editing the Dockerfile triggers exactly one rebuild on the next run.
- [ ] Regeneration over an operator-edited Dockerfile refuses or preserves, never silently
      overwrites.
- [ ] The diagnostic command reports the image and the agent version baked into it.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- Running agents inside the container and credential mounting — AWCLI-19.

## Dependencies

**Blocked by:** AWCLI-00
**Blocks:** AWCLI-19, AWCLI-22
