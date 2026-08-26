# AWCLI-25 — [AWCLI] Run commands on the host target, saying plainly what they can reach

**Points:** 2 · **Source:** WB-17 — unit added in review round 4, after this ticket (see Context) · **Status:** Ready

## Problem / Goal

`ctx.exec` is published on the frozen context surface and nothing builds it on the path every run
takes. AWCLI-19 owns the container target and every requirement it carries says "in the container",
so the *default* execution target — a command run on the machine awcli is running on — had no
owning unit at all. That is the same gap BR-038 and BR-039 closed for `ctx.fs` and `ctx.env`, in
its third instance.

The member is small; the property it carries is not. On this target a command runs as the operator,
with the operator's own reach, and a repository's declared command is the sharpest instance of it
— it is untrusted whole and its first word is the binary to run, so no way of passing it holds it
back. BR-040 makes that explicit, and this ticket is where the run says it out loud rather than
letting an operator infer containment from working-copy confinement (BR-038) that is not one.

## Context

**This is the default path, and BR-040 governs it.** The container target (AWCLI-19) is the
opt-in; a workflow that never asks for one never touches it, which is exactly why the honest
statement matters here and not there. Workspace and execution are orthogonal axes (ADR-0003), so
the working copy this runs in comes from the workspace axis (AWCLI-13) and is fixed when the scope
is made — not from an argument to this call.

Two things the `ExecApi` declaration in `src/contract/awcli.d.ts` already reasons about, which this
ticket builds rather than restates. A list of arguments is executed directly with no shell, so
every element is one argument however it is spelled — the form to use whenever a value from
elsewhere goes into a command the workflow otherwise wrote itself. A single string is handed to a
shell, because a repository's declared command is allowed to contain `&&` and pipes and would be
meaningless otherwise. That distinction is about which fragment can rewrite the command; BR-040 is
explicit that it settles nothing about reach.

Confinement does not extend to this call, and AWCLI-23 asserts that non-refusal rather than
assuming it — which is why this ticket blocks it. Git hooks living in the working copy are run by
`ctx.git.commit()` and by any command here that runs git, with the operator's own reach; only a
container is a boundary (BR-015).

## Requirements

### Functional

- Run a command on the host execution target and return what it left behind — exit code, standard
  output, standard error.
- Accept the two declared forms: a list of arguments executed directly with no shell, and a single
  string handed to a shell (BR-040).
- Resolve the command's working directory to the working copy the iteration is operating in, never
  the directory awcli was started from.
- Return a non-zero exit as a result, not a throw — a workflow running the repository's test
  command expects it to fail sometimes.
- Kill the command and reject the call at the requested wall-clock ceiling, and apply awcli's own
  default for the run when none is given — absent must not mean forever (BR-017, BR-018).
- Report, per call, that the command ran on the host and that the wider filesystem, the network and
  this machine's credentials remained reachable (BR-040, BR-015).
- Answer `ctx.version.supports("exec")` affirmatively once the member is built (BR-033).

### Non-Functional

- The reported isolation is read from what actually happened, never from what was requested — a
  container call that ran on the container reports the container (AWCLI-19 builds that half).
- A killed command leaves no orphaned child process behind, so an unattended run does not
  accumulate them over a night.
- Output is read without unbounded buffering, so a chatty command cannot grow the run's memory
  without limit.

## Constraints

- Nothing about the call form is described as a boundary, in the API, help text, docs, or logs. The
  word *sandbox* stays reserved for the container path (BR-015), and the report for this target
  states reach rather than containment (BR-040).
- The working copy comes from the context, and the execution target comes from the context; neither
  is selectable per call (ADR-0003).
- No new member or overload on the context surface — this implements a declared member and removes
  its stub.

## Acceptance Criteria

- [ ] Scenario: *The default execution target is named for what it is*.
- [ ] Scenario: *A repository's declared command runs whole on the host*.
- [ ] Scenario: *A value from elsewhere cannot become a second command*.
- [ ] The command's working directory is the directory `ctx.git.dir` reports, asserted from a
      process started in an unrelated directory.
- [ ] A command exiting non-zero resolves with that exit code rather than rejecting, and its
      standard error is readable from the result.
- [ ] A command that outlives its ceiling is killed and the call rejects naming the ceiling; a
      call given no ceiling still gets awcli's own default rather than none.
- [ ] `ctx.version.supports("exec")` returns true, and the member's entry in `DELIVERED_BY` is
      gone.
- [ ] All tests pass, lint clean, type check clean.

## Out of Scope

- Running a command inside a container, and the credential mount that goes with it — AWCLI-19.
- The format the per-call isolation line is rendered in, and redaction within it — AWCLI-21. This
  ticket owns what is true about the host target; AWCLI-21 owns how the run says it.
- Working-copy confinement for paths the workflow names — AWCLI-23. Confinement deliberately does
  not extend to this call.
- Running the agent itself as a subprocess — AWCLI-15.

## Dependencies

**Blocked by:** AWCLI-01, AWCLI-13
**Blocks:** AWCLI-23, AWCLI-24
