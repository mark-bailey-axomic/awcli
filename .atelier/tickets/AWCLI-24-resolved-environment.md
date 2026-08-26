# AWCLI-24 — [AWCLI] Answer the environment by name, with what awcli set for the run answering as unset

**Points:** 2 · **Source:** new — no work-breakdown unit (see Context) · **Status:** Ready

## Problem / Goal

`ctx.env` is published on the frozen context surface and nothing builds it, so reading it throws
on every build shipped so far. It also carries the promise BR-039 now states: the variables awcli
set for *this run* answer as *not set*. Those are lent to a container as a read-only mount for the
life of the run and never copied (BR-016), and answering with them would copy them into every prompt
and every run record that reads the answer — which is the thing BR-016 exists to prevent. BR-039 is
where the promise is stated; this ticket is where it gets built.

The test is what awcli set, not what looks like a credential, and that distinction is the whole
buildability of the requirement. awcli records a name as it sets it, so membership is a lookup. A
name the operator's own environment already carried is not in that set even when it is the same
name awcli would have used — an inherited agent API key answers with its value. And on the host
target awcli commonly sets nothing, so the subtraction is legitimately empty; an empty subtraction is
this requirement satisfied, not skipped.

**The member is an accessor, not a record**, and that changed before this ticket was built. A
`Readonly<Record<string, string | undefined>>` makes enumerate-and-forward the default: with the
whole environment in hand, writing it into a prompt or a log line is one expression that looks like
nothing in particular, and BR-039 could only advise against it. Asking by name — is this set, what
does it hold — makes forwarding something a workflow does deliberately, one name at a time. That is a
shape and not a boundary, and the ticket must not describe it as one: a workflow that names the
variables it wants can still forward all of them.

## Context

**This member is now governed like every other, by BR-039.** `ctx.env` was one of two members in
the TDD's context-members table whose Rules column was a dash — no business rule, and no
scenario in the approved feature file exercising it — which is why no work-breakdown unit ever
owned it and why `src/runtime/context.ts` had no unit to name for it. BR-039 governs what the
member answers: the variables awcli set for this run answer as not set. BR-016 is still cited below,
because it is the rule the credential promise points at, but it is a rule about a container mount
and BR-039 is the one about this member. The criteria below are the five scenarios plus what the
`env` declaration and its doc-comment in `src/contract/awcli.d.ts` add on top. The other dashed
member was `ctx.fs`, closed by BR-038 (AWCLI-23).

**What the accessor is not.** It is not a control over the workflow, and nothing here may be
described as one. A workflow that asks for six names and puts all six into a prompt has forwarded
its operator's environment, and awcli neither stops that nor claims to. Two limits stay exactly
where they were. What remains after the subtraction is the operator's own environment, which may
hold secrets of its own, an inherited agent API key included — awcli did not set them and does not
know them. And subtraction is not redaction: subtraction withholds what awcli set, by construction,
while redaction (AWCLI-21, which no business rule states) is a net cast over shapes awcli recognises
wherever they are written down. Subtraction also removes nothing from the machine — a command the
workflow runs still sees the environment its execution target actually has (BR-040).

The old note that the type could not keep the environment out of a log no longer describes the
surface, and it is worth saying why rather than deleting it. It rested on the member being a record
that `LogApi` would accept, so `ctx.log.info("env", ctx.env)` compiled. Both halves moved: there is
no whole environment to pass, and log field values widened to accept anything (BR-008), so nothing
in the types objects to logging either. What replaced the note is the shape — a name at a time —
not a refusal.

## Requirements

### Functional

- Answer two questions about a name and nothing else: whether it is set, and what it holds. No
  member of the surface yields the environment as a collection — there is nothing to enumerate,
  spread, or hand to another call (BR-039).
- Resolve the answers from what the execution target holds for this run — the host environment
  for a host target, the container's for a container target.
- Subtract the variables awcli set for this run, so they answer as not set rather than being
  filtered at each read site (BR-039, BR-016) — and subtract nothing else, however much a name
  resembles one.
- Leave the subtraction empty when awcli set nothing for the run, which on the host target is the
  common case, without reporting that anything was withheld (BR-039).
- Answer for a variable that was never set exactly as for one awcli withheld: the two are
  indistinguishable to the caller.
- Answer `ctx.version.supports("env")` affirmatively once the member is built (BR-033).

### Non-Functional

- The answers come from a snapshot resolved for the run, not from a live view of the process
  environment, so the same name answers the same way for the whole run.
- Subtraction is by construction, in one place: no caller has to remember to exclude a name.
- The set of subtracted names is what awcli recorded itself as setting, kept in one module
  alongside the credential mount it mirrors, so a credential added to the mount cannot be
  forgotten here — and so membership is a lookup rather than a resemblance test.

## Constraints

- A credential value must never be returned by any answer, not even redacted or truncated — "not
  set" is the only acceptable answer for a name awcli set for this run.
- The subtraction covers the names awcli set for this run and nothing else. A name the operator's
  own environment already carried answers with its value, even when it is the same name awcli
  would have set — an inherited agent API key answers.
- Nothing on the surface may return the environment whole, and nothing may be added later that
  does — a `names()`, an `all()` or a spreadable view would restore exactly the default BR-039
  removed, and is additive enough to look harmless.
- Changing `ctx.env` from a record to an accessor is a narrowing of the published surface and is
  therefore only possible before the v1 freeze (BR-033). It lands with AWCLI-01's declaration, not
  after it.

## Acceptance Criteria

- [ ] Scenario: *A variable awcli set for this run answers as not set*.
- [ ] Scenario: *My own environment is still there, an inherited API key included*.
- [ ] Scenario: *On the host target there may be nothing to leave out*.
- [ ] Scenario: *The environment answers by name and is never handed over whole*.
- [ ] Scenario: *A command the workflow runs still sees the whole environment*.
- [ ] Asking for a name answers with the value the execution target resolved, and asking for one
      that was never set answers as not set.
- [ ] The withholding is verified with those variables present in the parent environment (BR-016),
      and no value awcli set is returned by any answer, under any name.
- [ ] A run where awcli set nothing answers for every name exactly as the target's environment
      holds it, and no output claims a credential was withheld.
- [ ] A container target answers from the container's environment, not the host's.
- [ ] The answers do not change when the process environment changes mid-run.
- [ ] The subtracted-name set is defined once, next to the credential mount of AWCLI-19, and a
      test fails if the two fall out of step.
- [ ] A name present in the parent environment which awcli did not set for this run still answers,
      asserted with a name awcli would otherwise have used.
- [ ] `ctx.version.supports("env")` returns true, and the member's entry in `DELIVERED_BY` is
      gone.
- [ ] All tests pass, lint clean, type check clean.

## Out of Scope

- Redacting values matching known secret shapes from logs and run records — AWCLI-21. This
  ticket makes awcli's own credentials unanswerable; it does not make what remains safe to
  forward, and neither the rule nor the declaration claims that it is.
- Preventing a workflow from logging or interpolating what it asked for. Asking by name makes
  bulk forwarding deliberate, not impossible; the workflow decides what is worth recording
  (BR-028), and log field values accept anything (BR-008), so nothing in the types objects.
- Mounting credentials into a container — AWCLI-19. This ticket mirrors that set, it does not
  own it.
- Running a command on the host target — AWCLI-25. This ticket reads that target's environment;
  it does not build the target.

## Dependencies

**Blocked by:** AWCLI-01, AWCLI-19, AWCLI-25
**Blocks:** None — no other ticket names `ctx.env` in its requirements.
