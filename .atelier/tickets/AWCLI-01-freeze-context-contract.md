# AWCLI-01 — [AWCLI] Freeze the context contract and assert the runtime against it

**Points:** 2 · **Source:** WB-1 (part 1 of 2) · **Status:** Done

## Problem / Goal

A workflow author has nothing to write against until the shape of `ctx` is decided and
published. Every other unit either implements a member of that surface or consumes it, so the
contract has to exist first — and it has to be a real artifact the author's editor can read,
not a promise in a design document.

## Context

Types reach the author as a generated ambient declaration committed into the repository, not
as an installed package — see ADR-0002. Workflows must remain runnable in repositories with no
`node_modules` at all, which is why nothing in the surface may require an import. The declared
surface and its per-member rules are tabulated in the TDD's Contracts section.

## Requirements

### Functional

- Publish the full context surface as a standalone declaration: agent, sandbox, state, args,
  project, git, exec, fs, log, env, schema, version.
- Publish the workflow module contract: the default export, and the optional `limits` and
  `state` exports.
- Expose the running contract version so a workflow can feature-detect rather than crash.
- Enforce agreement between the declaration and the runtime at build time, in a way that fails
  the build when they drift.

### Non-Functional

- The declaration compiles with no dependency on any package being installed.
- Additive change only: a member may be added, never removed or narrowed, within a major.
- The conformance check runs as part of the normal build, not as a manual step.

## Constraints

- No runtime import may be required of a workflow file for anything on the surface.
- Members not yet implemented are declared and must fail loudly when called, never silently
  no-op.
- Do not generate the declaration from the implementation — it is authored, and the
  implementation is checked against it (ADR-0002).

## Acceptance Criteria

- [x] The declaration type-checks standalone, in a directory with no installed packages.
- [x] A deliberate divergence between runtime and declaration fails the build, naming the member.
- [x] Scenario: *A workflow written earlier still runs on a later awcli*.
- [x] Unimplemented members throw a named "not yet implemented" error rather than returning undefined.
- [x] All tests pass, format check clean, type check clean.

**On the five:** each was confirmed by PR #8's fourth review round, against the branch as it stood
at `7e5a9b5`, not by the author asserting it. **On the two that are no longer here:** that same round
added a `readonly` requirement and two criteria for it, and PR #8 merged without the code for either.
They are AWCLI-26's, requirement and criteria together, so that exactly one ticket carries them —
which is why this one is `Done` at five criteria rather than sitting at `In Review` behind work it
does not own.

## Out of Scope

- Writing the declaration into a target repository — that is AWCLI-22, which writes the whole
  initial layout: Dockerfile, configuration, context declaration and the single ignore entry.
  AWCLI-21 is logging, isolation reporting and spend, which this pointer named by mistake.
- The final shape of the surface — every function `readonly` and the context frozen at run time,
  `ctx.env` as an accessor, `LogApi` accepting the contract's own return types — and proving the
  declaration ships in the tarball and in a global install. That is AWCLI-26. This ticket froze the
  contract and asserted the runtime against it; AWCLI-26 lands the three shape decisions PR #8's
  fourth review round took after that assertion was already in place.
- Any driver, loader or loop behaviour.

## Dependencies

**Blocked by:** AWCLI-00
**Blocks:** AWCLI-02, AWCLI-05, AWCLI-15, AWCLI-26
