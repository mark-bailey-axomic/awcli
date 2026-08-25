# AWCLI-24 — [AWCLI] Resolve the run's environment, with awcli's own credentials subtracted

**Points:** 2 · **Source:** new — no work-breakdown unit (see Context) · **Status:** Ready

## Problem / Goal

`ctx.env` is published on the frozen context surface and nothing builds it, so reading it throws
on every build shipped so far. It also carries the promise BR-039 now states: awcli's own agent
credentials are *absent* from the record it hands a workflow. They are lent to a container as a
read-only mount for the life of the run and never copied (BR-016), and handing them back through
this record would copy them into every prompt and every run record that reads it — which is the
thing BR-016 exists to prevent. The declaration says plainly that this subtraction "is a promise
about the record awcli builds, not something this type states or enforces — and it is not built."
BR-039 is now where it is stated; this ticket is where it gets built.

## Context

**This member is now governed like every other, by BR-039.** `ctx.env` was one of two members in
the TDD's context-members table whose Rules column was a dash — no business rule, and no
scenario in the approved feature file exercising it — which is why no work-breakdown unit ever
owned it and why `src/runtime/context.ts` had no unit to name for it. BR-039 governs the record
itself: the agent credentials awcli supplies are absent from it. BR-016 is still cited below,
because it is the rule the credential promise points at, but it is a rule about a container mount
and BR-039 is the one about this record. The criteria below are the three approved scenarios plus
what the `env` declaration and its doc-comment in `src/contract/awcli.d.ts` add on top. The other
dashed member was `ctx.fs`, closed by BR-038 (AWCLI-23).

Two limits the declaration is explicit about, and this ticket inherits rather than fixes. The
type cannot keep the record out of a log: `Readonly<Record<string, string | undefined>>` is a
valid `LogApi` field record, so `ctx.log.info("env", ctx.env)` compiles, and branding the record
to refuse it would distort `LogApi` for every caller and still be defeated by a spread. And what
remains after the subtraction is the operator's own environment, which may hold secrets of its
own — so this is somewhere to read a specific known variable from, not somewhere to enumerate
and forward. Subtraction and redaction are different mechanisms, as BR-039 says: subtraction
removes awcli's own credentials from the record by construction, while redaction (AWCLI-21, which
no business rule states) is a net cast over shapes awcli recognises wherever they are written
down. And subtraction removes nothing from the machine — a command the workflow runs still sees
the environment its execution target actually has.

## Requirements

### Functional

- Build the record from what the execution target resolves for this run — the host environment
  for a host target, the container's for a container target.
- Subtract awcli's own agent credentials from the record, so they are absent rather than
  filtered at each read site (BR-039, BR-016).
- Report a variable that is not set as absent, on the same terms as one awcli removed.
- Answer `ctx.version.supports("env")` affirmatively once the member is built (BR-033).

### Non-Functional

- The record is a snapshot resolved for the run, not a live view of the process environment.
- Subtraction is by construction, in one place: no caller has to remember to exclude a name.
- The set of subtracted names is stated in one module alongside the credential mount it mirrors,
  so a credential added to the mount cannot be forgotten here.

## Constraints

- A credential value must never be written into the record, not even redacted or truncated — an
  absent key is the only acceptable representation.
- The subtraction must not silently remove an operator variable that merely resembles a
  credential name; it removes what awcli itself supplies and nothing else.
- No new member or overload on the context surface — this implements a declared member and
  removes its stub.

## Acceptance Criteria

- [ ] Scenario: *The environment a workflow is given holds none of awcli's own credentials*.
- [ ] Scenario: *My own environment is still there, secrets and all*.
- [ ] Scenario: *A command the workflow runs still sees the whole environment*.
- [ ] A variable read from the record carries the value the execution target resolved, and one
      that was never set is absent.
- [ ] The credential absence is verified with those variables present in the parent environment
      (BR-016), and no credential value appears anywhere in the record, under any key.
- [ ] A container target's record reflects the container's environment, not the host's.
- [ ] The record does not change when the process environment changes mid-run.
- [ ] The subtracted-name set is defined once, next to the credential mount of AWCLI-19, and a
      test fails if the two fall out of step.
- [ ] `ctx.version.supports("env")` returns true, and the member's entry in `DELIVERED_BY` is
      gone.
- [ ] All tests pass, lint clean, type check clean.

## Out of Scope

- Redacting values matching known secret shapes from logs and run records — AWCLI-21. This
  ticket makes awcli's own credentials absent; it does not make the record safe to log
  wholesale, and the declaration does not claim that it is.
- Preventing a workflow from logging or interpolating the record. The type cannot, and the
  declaration says so; the workflow decides what is worth recording (BR-028).
- Mounting credentials into a container — AWCLI-19. This ticket mirrors that set, it does not
  own it.

## Dependencies

**Blocked by:** AWCLI-01, AWCLI-19
**Blocks:** None — no other ticket names `ctx.env` in its requirements.
