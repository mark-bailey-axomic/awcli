# AWCLI-01 — [AWCLI] Freeze the context contract and assert the runtime against it

**Points:** 2 · **Source:** WB-1 (part 1 of 2) · **Status:** In Review

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
- Declare every function on the surface as a member that cannot be reassigned, so a workflow —
  or a module it imported without reading — cannot put its own function over the one awcli gave
  it (BR-025). This covers the logging calls the run's record is written through, and the
  members a `sandbox()` scope binds to its own working copy and execution target (BR-038,
  BR-040).
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
- [x] All tests pass, lint clean, type check clean.
- [ ] Scenario: *A workflow cannot put its own function over the one that writes the record*.
- [ ] No function anywhere on the surface — including inside the sub-APIs — can be assigned
      over, asserted by a test that tries it for each one rather than by inspection.

**On the ticked five:** each was confirmed by PR #8's fourth review round, against the branch as it
stood at `7e5a9b5`, not by the author asserting it. **On the two unticked:** they were added by that
same round, along with the `readonly` requirement above, and are being built now — this ticket is not
finished, and the status says so.

## Out of Scope

- Writing the declaration into a target repository — that is AWCLI-22, which writes the whole
  initial layout: Dockerfile, configuration, context declaration and the single ignore entry.
  AWCLI-21 is logging, isolation reporting and spend, which this pointer named by mistake.
- Any driver, loader or loop behaviour.

## Dependencies

**Blocked by:** AWCLI-00
**Blocks:** AWCLI-02, AWCLI-05, AWCLI-15
