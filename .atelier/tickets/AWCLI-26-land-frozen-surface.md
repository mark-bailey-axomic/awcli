# AWCLI-26 — [AWCLI] Land the frozen context surface's final shape, and prove it ships

**Points:** 2 · **Source:** new — completes AWCLI-01's review round 4 (see Context) · **Status:** Done

## Problem / Goal

`main` specifies a context surface it does not implement. PR #8's fourth review round took three
decisions about the shape of `ctx` and wrote them into the rules, the feature file and the
declaration's own prose; the code that implements them did not merge with it. So every reader of
the specification is now told something about `ctx` that is false of the binary:

- BR-025 requires every function member of the surface to be fixed at the moment the workflow
  receives it. The functions are writable, and nothing freezes the object at run time.
- BR-039 says the environment answers one name at a time and is never handed over whole.
  `ctx.env` is declared as a record of the entire environment.
- BR-008 says a log field is checked as the line is written down. `LogApi` constrains its fields
  to `Storable` at the call instead, which means `ExecResult`, `Commit` and `ctx.args` — three
  shapes awcli itself hands the workflow — cannot be logged at all.

Two smaller gaps travel with them. The declaration is absent from the published tarball and from
a global install, which is the file AWCLI-22 exists to write into a target repository. And
AWCLI-01 stands at `In Review` with two criteria unticked, because they were added by that round
and describe work this ticket carries.

The goal is to make the code true of the specification that merged, and to gate each half so the
pair cannot drift apart again.

## Context

**This ticket exists because a specification merged ahead of its implementation, not because a
decision changed.** Nothing below is a new judgement. Each of the three surface changes was
argued, agreed and built during PR #8's fourth review round, and the rules stating them are on
`main` already — the code was simply left behind when the PR merged. That is the fact a reader
needs, because otherwise the natural reading of a ticket that narrows `ctx.env` and widens
`LogApi` is that the contract is being reopened. It is not: it is being finished.

**The surface is still safe to change, and this is the last moment that is true.** BR-033 freezes
the declared surface before the machinery behind it and permits additions only, which would forbid
narrowing `ctx.env` from a record to an accessor — but its Exceptions are explicit that there are
none before first release, and nothing has been released. There is no tag, no npm publish,
`package.json` still carries `private: true`, and no ticket has yet been built against the
contract, so no committed workflow anywhere is written against the record shape. Once any of those
stops being true, BR-039 could only be satisfied by a major version. That is why this lands now
and as one ticket rather than being folded into the tickets that consume the members.

**Why the three belong together.** They are one object's shape, checked by one conformance
mechanism. `src/contract/conformance.ts` compares the declaration against the runtime member by
member, including modifiers, so a `readonly` added on one side and not the other fails the build —
which means the modifiers cannot land in halves. `ctx.env` changing from data to an accessor
changes how the member refuses on an unbuilt build, from a throw at the property read to a throw
inside `get()`, which is a fact `not-implemented.test.ts` asserts. And the `LogApi` widening is
what makes the frozen corpus able to log the values the other two members return. Splitting them
would mean three passes over the same declaration with a red build between each.

**What the members do here is still refuse.** This ticket settles declared shape and run-time
fixity; it builds no member. `ctx.env` gains `get` and `has` that both throw, and the units that
answer for real are unchanged — AWCLI-24 for the environment, AWCLI-21 for logging, AWCLI-25 and
AWCLI-19 for the execution targets. `DELIVERED_BY` keeps every entry it has.

## Requirements

### Functional

- Declare every function on the surface as a member that cannot be assigned over, at both levels —
  the members of `ctx` itself and the functions inside each sub-API (BR-025).
- Freeze the context object and each sub-API at run time, so an assignment over a logging call is
  refused even from a caller that reached the context from JavaScript, through a cast, or from a
  workflow whose editor never read the declaration (BR-025).
- Declare `ctx.env` as an accessor over a single name — whether it is set, and what it holds — with
  no member anywhere on the surface yielding the environment as a collection (BR-039).
- Widen a log field's declared type so that the values awcli hands the workflow can be logged, and
  state in the declaration that storability is answered where the line is written rather than at
  the call (BR-008).
- Keep the conformance check exhaustive across the change: a modifier present on one side and
  absent on the other must fail the build, naming the member.
- Ship the declaration inside the published package and lay it down on a global install, at a path
  AWCLI-22 can read at run time.

### Non-Functional

- Freezing is shallow and applied per object, because the assignment BR-025 names is over a
  function inside a sub-API, not over the sub-API itself.
- The run-time freeze does not weaken the compile-time claim or substitute for it; the declaration
  remains the artifact an author's editor reads, and the freeze is what holds when nothing read it.
- The packaging claim is proved against a real tarball and a real install, not against the build
  configuration that is supposed to produce them.
- The corpus of frozen construction-position fixtures grows to exercise the new shapes, so a later
  narrowing of either is caught by a fixture failing to compile.

## Constraints

- No member is built and no entry leaves `DELIVERED_BY`. A member whose stub is removed here would
  make `ctx.version.supports()` answer true for something that cannot run, which is the one
  direction BR-033 forbids.
- The narrowing of `ctx.env` is only permissible before first release, and the ticket must say so
  where it is made rather than relying on this document (BR-033).
- Widening a log field's type must not weaken the state check it is often confused with: a value
  put into shared state is still refused at the assignment that set it (BR-008).
- The run-time freeze is hygiene against accident and a careless import, and may not be described
  anywhere — in the API, its doc comments, help text or logs — as a control over a workflow's
  author. Only a container is a boundary (BR-015, BR-025).
- Nothing may be added to the surface that returns the environment whole, now or later (BR-039).

## Acceptance Criteria

- [x] Scenario: *A workflow cannot put its own function over the one that writes the record*.
- [x] No function anywhere on the surface — including inside the sub-APIs — can be assigned
      over, asserted by a test that tries it for each one rather than by inspection.
- [x] A `readonly` modifier dropped from a function on either side of the contract fails the
      build, naming the member, asserted for a top-level member and for a function inside a
      sub-API.
- [x] `ctx.env` exposes no member that yields the environment as a collection, and a fixture that
      treats it as a record no longer compiles.
- [x] A log call accepts the values awcli hands the workflow — a command's result, a commit, the
      run's arguments — and the declaration states where storability is answered instead.
- [x] Adding a member to the context object, or deleting one, is refused as well as overwriting
      one; and a member that is declared but unbuilt still refuses after the freeze.
- [x] The published tarball carries the declaration byte-identical to the source it was built
      from, proved by packing the package rather than by reading its configuration.
- [x] A global install lays the declaration down where a later ticket can read it, checked by the
      existing global-install gate.
- [x] The declaration's own prose admits which members this build cannot run, held against the
      table that records them by a test rather than by review.
- [x] All tests pass, lint clean, type check clean.

**On the ticks:** every box above is confirmed by a gate or a test that runs in this branch —
`npm run check` and `npm run check:gates`, the latter including the contract gate's readonly and
optional-field cases and the packaging gate — not by the author asserting it. The status stays
`In Review` until the PR carrying them is reviewed and merged, per the convention in
[`README.md`](README.md).

## Out of Scope

- Building any member of the surface. `ctx.env` still throws, and AWCLI-24 is what answers a name
  for real; `ctx.log` still throws, and AWCLI-21 is what writes a line.
- Deciding what a log field that cannot be written down is recorded as. BR-008 says the line is
  still written and the field is named unrepresentable; this ticket widens the declared type so
  that check has somewhere to happen, and AWCLI-21 performs it.
- Subtracting the variables awcli set for the run from what the environment answers — AWCLI-24.
  This ticket settles the accessor's shape and nothing about what it will answer.
- Writing the declaration into a target repository, and the runtime layout around it — AWCLI-22.
  This ticket makes the file reachable from an install; AWCLI-22 is what reads it.
- Redacting secret-shaped values from logs and run records — AWCLI-21. No rule states it and this
  ticket does not approach it.
- Making the record proof against the workflow's own author. A workflow runs in awcli's process
  and BR-025's Exceptions say plainly what that costs.

## Dependencies

**Blocked by:** AWCLI-01
**Blocks:** AWCLI-24 — the accessor shape is a narrowing of the published surface, and AWCLI-24's
own constraints require it to land with the declaration rather than after it.
