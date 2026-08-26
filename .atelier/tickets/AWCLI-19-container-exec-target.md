# AWCLI-19 — [AWCLI] Hand back a sandbox scope, and run in its container with credentials lent, never baked

**Points:** 3 · **Source:** WB-11 (part 2 of 2) · **Status:** Ready

## Problem / Goal

A workflow that asks for a container is asking for a containment guarantee. Quietly falling back
to host execution when the daemon is unavailable would break that guarantee at the worst moment.
And credentials must be lent to a container for the life of a call, never baked into an image
that could be pushed or shared.

`ctx.sandbox()` is how a workflow asks, and it does not hand back a container. It hands back a
`Scope`: a working copy of its own, the container to run in, the isolation actually obtained, and
a `dispose()`. Building that object is this ticket too. Nothing else builds it — AWCLI-13
provisions working copies but is never the thing that asks for one on a scope's behalf, AWCLI-03
provides the stack a scope registers with, and AWCLI-10 makes the scope's state refuse a write at
run time. All three presuppose a scope that something has already constructed.

## Context

**This ticket owns `ctx.sandbox` end to end** — the composition and the container inside it. Both
halves come from WB-11, whose Contracts column names `ctx.sandbox` alongside `ExecTarget`
(container). An earlier draft of this ticket scoped itself to "the container target only", which
read as a clean split against AWCLI-25 but left the construction of the scope owned by nothing:
every requirement was about running a command in a container, and none was about the object that
hands one out. The default execution target — a command run on the host, with the operator's own
reach — is still AWCLI-25, governed by BR-040. A container is the only thing that changes what a
command can reach (BR-015), which is what makes the container the opt-in half rather than the
whole of `ctx.exec`.

Workspace and execution are orthogonal axes (ADR-0003), so the execution axis can fail without
disturbing the workspace axis — a container refusal does not affect a workflow that never asked
for one. `sandbox()` is the one composition that fixes both, and it fixes them at construction:
`worktree × container`. Neither is selectable afterwards, and nothing a workflow passes selects
the workspace (BR-014) — `SandboxOptions` carries a slot name and nothing else.

**No new rule is needed for any of this**, which is what separates it from AWCLI-23, AWCLI-24 and
AWCLI-25. BR-004 is the refusal, BR-016 the credential mount, BR-012 the read-only state the scope
hands back, BR-015 the isolation stated at every call made inside it, BR-036 the slot-named branch
a resumed run reattaches, and BR-021 the disposal that survives an interrupt. The behaviour was
specified all along; what was missing was a unit that builds the object those rules describe.

This is the second half of the container work; the image itself comes from AWCLI-18.

## Requirements

### Functional

- Hand back a `Scope` from `ctx.sandbox()`: the context to use inside it, the isolation actually
  obtained, and a `dispose()`.
- Acquire the scope's own working copy for the slot named in `SandboxOptions`, so a resumed run
  reattaches the branch that slot already had (BR-036) and two scopes never share a tree (BR-013).
- Fix both isolation axes at construction — `worktree × container` — and report them from what was
  obtained, never from what was requested (ADR-0003, BR-015).
- Wire the scope's context so every member operates within the scope: `exec` bound to the container
  target, `fs` and `git` to the scope's own working copy, `state` as the read-only view the frozen
  contract types (BR-012).
- Run a command or an agent inside the container, in the current working copy.
- Refuse the run when a container was requested and the runtime is unavailable — never downgrade
  silently.
- Leave a workflow that requested no container entirely unaffected by an absent runtime.
- Mount credentials read-only for the duration of a call, and release them with the container.
- Report per call which isolation was actually in effect.
- Dispose a scope by removing its container and releasing its working copy, leaving the working
  copy on disk and its branch undeleted — the commits are the deliverable (BR-021, BR-036).

### Non-Functional

- The refusal is a refusal, with the reserved refusal exit code and a named cause.
- No credential value appears in the image, in a command line, or in any record or log.
- Container availability is probed once per run, not once per call.
- A scope that fails partway through construction leaves nothing behind: a working copy obtained
  before the container was refused is released rather than orphaned.

## Constraints

- Host path to container path mapping is isolated behind one module, so the non-POSIX path
  stays viable (ADR-0007).
- The container is registered with the disposal stack at creation, and so is the working copy — a
  scope never relies on its own `dispose()` being reached (BR-021).
- Nothing a workflow passes selects either axis; `SandboxOptions` carries the slot name and nothing
  else (BR-014, ADR-0003).
- No new member or overload on the context surface — this implements a declared member and removes
  its stub (BR-033).

## Acceptance Criteria

- [ ] Scenario: *A requested container is never silently downgraded*.
- [ ] Scenario: *A workflow that asks for no container is unaffected by its absence*.
- [ ] Scenario: *Credentials are lent to a container, never baked into it*.
- [ ] An inspection of the built image finds no credential material.
- [ ] The container is removed on normal end, on failure and on interrupt.
- [ ] `ctx.sandbox()` resolves to a scope reporting `worktree × container`, whose `ctx.git.dir` is
      a different directory from the body's, and whose `ctx.state` is the read-only view.
- [ ] Two scopes taken in one run get different working copies; the same slot name in a resumed run
      reattaches the branch it already had.
- [ ] `scope.dispose()` removes the container and leaves the working copy and its branch on disk;
      a run that ends without calling it disposes the scope anyway.
- [ ] A container refused after the working copy was obtained leaves no working copy behind.
- [ ] `ctx.version.supports("sandbox")` returns true, and the member's entry in `DELIVERED_BY` is
      gone.
- [ ] All tests pass, lint clean, type check clean.

## Out of Scope

- Image generation and build caching — AWCLI-18.
- Per-call isolation reporting format — AWCLI-21.
- Command execution on the host target, and what BR-040 says a command reaches there — AWCLI-25.
- The run-time refusal underneath the scope's read-only state, and the in-flight window that closes
  writes in the body — AWCLI-10. This ticket hands back the view the contract types; AWCLI-10 is
  what makes a cast through it fail.
- Working-copy provisioning itself — AWCLI-13. This ticket asks for one by slot name; it does not
  build the mechanism that produces it.

## Dependencies

**Blocked by:** AWCLI-01, AWCLI-03, AWCLI-13, AWCLI-18
**Blocks:** AWCLI-10, AWCLI-24
