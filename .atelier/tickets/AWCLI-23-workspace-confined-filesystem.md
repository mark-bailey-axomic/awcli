# AWCLI-23 — [AWCLI] Read and write within the working copy, refusing paths that leave it

**Points:** 2 · **Source:** new — no work-breakdown unit (see Context) · **Status:** Ready

## Problem / Goal

`ctx.fs` is published on the frozen context surface and nothing builds it, so a workflow that
reads or writes a file gets a "not yet implemented" refusal on every path. The member is small,
but the property it carries is not: a relative path in a workflow must be resolved against the
working copy this iteration is operating in, and a path that leaves that working copy must be
refused rather than resolved (BR-038). Without that, a mistyped `../` in a workflow reaches the
operator's other files, which is exactly the failure the worktree default (BR-014) exists to
prevent.

## Context

**This member is now governed like every other, by BR-038.** `ctx.fs` was one of two members in
the TDD's context-members table whose Rules column was a dash — no business rule, and no
scenario in the approved feature file exercising it — which is why no work-breakdown unit ever
owned it and why `src/runtime/context.ts` had no unit to name for it. BR-038 and its five
scenarios close that, so the criteria below are approved scenarios, as every other ticket's are.
What the scenarios do not state, the `FsApi` declaration and its doc-comment in
`src/contract/awcli.d.ts` do; nothing here asserts more than those two together publish. The
other dashed member was `ctx.env`, closed by BR-039 (AWCLI-24).

Two things BR-038 and the declaration are careful about, and this ticket must not overstate.
Confinement protects the operator's *other files*; it is not a boundary around the agent — git
hooks living in the working copy are run by `ctx.git.commit()` and by any `ctx.exec` that runs
git, with the workflow's own reach, and only a container is a boundary (BR-015), which is why
BR-038 states this as hygiene. And reaching outside the working copy deliberately is what
`ctx.exec` is for; the refusal exists so that a mistyped path cannot do by accident what an
explicit act should do on purpose. That non-refusal is asserted here rather than assumed, which
is why `ctx.exec` (AWCLI-19) is a blocker.

`AgentOptions.promptFile` is declared as confined "on the same terms as `ctx.fs.read`", and the
declaration calls it the sharper of the two because its contents leave the machine by
construction. The two must not be allowed to drift.

## Requirements

### Functional

- Read a file's contents by a path resolved against the working copy this iteration is
  operating in.
- Write contents to a path resolved the same way, creating the file if it is not there.
- Refuse a path that escapes the working copy — whether by `..`, by being absolute, or by
  traversing a symlink that points outside — rather than resolving it (BR-038).
- Answer `ctx.version.supports("fs")` affirmatively once the member is built (BR-033).

### Non-Functional

- Path resolution and the escape check live in one module, because `AgentOptions.promptFile`
  is confined on the same terms and the two must not diverge.
- A refusal names the offending path and says it left the working copy, so the cause is
  readable without a debugger.
- Confinement holds for the working copy actually in effect, on the host or in a container.

## Constraints

- Confinement is stated as protection for the operator's other files, never as a boundary
  around the agent — the word "sandbox" stays reserved for the container path (BR-015).
- An escape is refused, never silently clamped to the working copy root: a path that resolved
  to something other than what the workflow wrote is worse than a refusal.
- No new member or overload on the context surface — this implements a declared member and
  removes its stub.

## Acceptance Criteria

- [ ] Scenario: *A workflow's paths are read against the working copy it was given*.
- [ ] Scenario: *A path that climbs out of the working copy is refused*.
- [ ] Scenario: *A path given from the root of the machine is refused*.
- [ ] Scenario: *A link pointing out of the working copy is refused*.
- [ ] Scenario: *Reaching outside the working copy on purpose is not refused*.
- [ ] Resolution is against the directory `ctx.git.dir` reports, never the process working
      directory, and a write resolves on the same terms as a read, creating the file if it is
      not there.
- [ ] `promptFile` and `fs.read` resolve and refuse identically, exercised through one shared
      resolver.
- [ ] `ctx.version.supports("fs")` returns true, and the member's entry in `DELIVERED_BY` is
      gone.
- [ ] All tests pass, lint clean, type check clean.

## Out of Scope

- The resolved environment and its credential subtraction — AWCLI-24.
- Building `ctx.exec` itself — AWCLI-19. This ticket asserts only that confinement does not
  extend to it.
- Wiring `promptFile` into an agent call — AWCLI-15; this ticket supplies the resolver it uses.

## Dependencies

**Blocked by:** AWCLI-01, AWCLI-13, AWCLI-19
**Blocks:** None — no other ticket names `ctx.fs` in its requirements.
