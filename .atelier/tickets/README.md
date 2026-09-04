# awcli — implementation tickets

30 tickets, 75 points, twenty-five of them derived from the 17-unit work breakdown in
[`../design/agentic-workflow-cli-tdd.md`](../design/agentic-workflow-cli-tdd.md) and worth 65 of the
points. Those twenty-five carry three of the thirteen extra points over the design's 62, and all three
come from splits that did not go evenly. Five of the seven 5-point units were split
into a 3 and a 2, which adds nothing. The other two of the seven, WB-8 and WB-11, each became two
3-point tickets; and WB-5 — a 3-point unit, not one of the seven — became two 2-point ones.
Separating the lock from the record, the sandbox scope from the container inside it, and `ctx.git`
from the provisioning that needs only half of it each revealed work the single estimate had
compressed. AWCLI-00 accounts for two more: project scaffolding the
work breakdown never named, because a design document assumes a project exists.
AWCLI-26 accounts for two more, and for a different reason again: no unit was missing and no
estimate was wrong — PR #8 merged the specification of the context surface's final shape without the
code that implements it, so the work exists as a ticket only because a merge left it behind.
AWCLI-27, AWCLI-28 and AWCLI-29 account for the last six, and are the first three tickets here that
describe no product behaviour at all. All three came out of PR #15's review — the first two as
surrounding observations and AWCLI-29 as a finding raised in two rounds and fixed in neither — debt
in how this repository is worked in, how its own specification is checked, and where its filesystem
guards live, none of it caused by the PR that surfaced them. AWCLI-27 moves the session worktree
exclusion into a tracked file so each tool that walks the tree stops keeping its own copy; AWCLI-28
populates the manifest's empty traceability so a renamed scenario cannot silently lose its test;
AWCLI-29 extracts the six filesystem guards that `run-lock.ts` and `workspace.ts` each carry a copy
of, which have drifted once already and are drifting again, and — since PR #15's sixth review round —
`workspace.ts`'s refusal-message layer with them, which was 600 lines of the file when run 7 measured
it and is the seam four review rounds found the most defects in. That widening is what took it from 2 points to 3: the two
moves re-anchor `verify-workspace-gate.sh` and doing them together re-anchors it once. Counting them
against the design's 62 would suggest the breakdown had underestimated the product, and it had
not — this is the cost of the project around it.

The breakdown was fourteen units and 56 points until PR #8's fourth review round. WB-15, WB-16 and
WB-17 were added then for `ctx.fs`, `ctx.env` and `ctx.exec` on the host — the three context members
the design had left unowned, which AWCLI-23, AWCLI-24 and AWCLI-25 had been delivering with nothing
above them. The units carry those tickets' own estimates unchanged, so the ticket total did not move
and the six points they contribute are no longer extra to the design.

Every one of the 78 BDD scenarios appears as an acceptance criterion on exactly one ticket.
Acceptance criteria written in *italics* are scenario names from
[`../design/agentic-workflow-cli-bdd.feature`](../design/agentic-workflow-cli-bdd.feature) —
those are the tests, verbatim.

**Fifty-nine of those scenarios are PM-approved; nineteen are not yet.** The rules and the feature
file were approved on 2026-08-24 at 37 rules and 60 scenarios, and were amended during PR #8
(AWCLI-01) review rounds 2, 3 and 4: three rules added and six of the thirty-seven rewritten,
eighteen scenarios added and one of the sixty rewritten. PR #15 (AWCLI-13) then rewrote a seventh,
BR-036, whose Exceptions now carry the failed-add branch rollback that ticket's code performs. So 30
of the 40 rules and 59 of the 78 scenarios stand as approved, and 10 rules and 19 scenarios are
pending.

A rewritten scenario is not an approved one, which is the arithmetic this paragraph used to get
wrong: it said sixty were approved two sentences after saying three had been rewritten. It is also
why the pending counts are not simply "added plus rewritten". Three further scenarios and two
further rules were rewritten during these rounds, and each was itself added earlier in the same
PR — a scenario added and then rewritten before any gate is one pending scenario, not two.

The `## Amendments` section of
[`../design/agentic-workflow-cli-rules.md`](../design/agentic-workflow-cli-rules.md) records each
change, its date and the finding that drove it. Every ticket below derived from an amended rule
inherits that pending status: AWCLI-01, AWCLI-06, AWCLI-09, AWCLI-10, AWCLI-13, AWCLI-21, AWCLI-22,
AWCLI-23, AWCLI-24, AWCLI-25 and AWCLI-26.

The converse does not hold, and it applies to seven tickets: AWCLI-00, AWCLI-03, AWCLI-15,
AWCLI-18, AWCLI-27, AWCLI-28 and AWCLI-29. That list is now computed rather than counted —
`verify-spec-invariants.sh` check 14a reads it off the tickets and fails if this sentence disagrees —
because the sentence has been wrong in three consecutive review rounds: four, then six, then six
again in the same commit that added the seventh ticket and did not add it here.

Three of the seven describe no product behaviour at all. AWCLI-27, AWCLI-28 and AWCLI-29 carry no
scenario because a tracked ignore entry, a traceability check and one copy of the filesystem guards
are properties of the repository rather than of the tool, and writing scenarios for them would put
statements about awcli's own toolchain into a feature file that specifies what awcli does. The other
four are a different case: scaffolding, the disposal stack, the agent driver and the image build are
machinery whose observable behaviour is asserted on the tickets built on top of them — 04, 16, 17, 19
and 21.

That second group was six until BR-038 and BR-039 were added: `ctx.fs` and `ctx.env` were the only
two of the twelve context members the TDD governed with no business rule — a dash in its Rules
column — and no scenario exercised either, so AWCLI-23 and AWCLI-24 derived their criteria from the
frozen declaration instead. Those two rules close that gap, each with scenarios of its own; the
declaration still supplies what the scenarios do not state. Exact counts per amendment are in the
rules file's `## Amendments` section rather than repeated here.

A third member had the same shape of gap without a dash to show it: `ctx.exec` cited BR-032, but
every requirement that named it lived on AWCLI-19, which is the container target throughout — so
the *default* target, a command run on the host, was owned by nothing. BR-040 states what that
target actually is and AWCLI-25 builds it.

A fourth member closes the class, and it is the one that needed no rule. `ctx.sandbox` is a scope
factory: it returns a context whose state is a deep read-only view, whose `ctx.exec` is bound to the
container target, and whose workspace axis is fixed at construction (ADR-0003). AWCLI-19 mapped to
it and delivered only the container inside it — every requirement the ticket carried was about
running a command in one, and none was about the object that hands one out. But the difference from
the three above is where the gap lived. WB-11's Contracts column names `ctx.sandbox`, so the work
breakdown did assign the member; the ticket derived from it narrowed itself. And every behaviour the
scope has is already stated — BR-004 refuses the downgrade, BR-016 lends the credentials, BR-012
makes the state read-only, BR-015 states the isolation, BR-036 names the branch, BR-021 disposes it
on an interrupt. So this one is a ticket-scope correction and not a spec amendment: AWCLI-19 was
widened to own `ctx.sandbox` end to end and re-estimated at 3 points, no rule was added and no
scenario was written. It also surfaced a dependency that had been invisible while nobody owned the
construction — AWCLI-10 freezes state inside a `sandbox()` scope, so it cannot land before the
ticket that builds one.

A fifth member has closed the same way, and it is the second where a rule would have been the wrong
instrument. `ctx.git` is assigned by WB-8, which is AWCLI-13 and AWCLI-14 between them — AWCLI-13
provisions a working copy and constructs no context around one, AWCLI-14 reattaches it, and neither
named `GitApi`'s `log`, `diff` or `commit` — which, checked rather than assumed, no acceptance
criterion on any ticket consumes at all. That argues for one ticket owning the whole member more
strongly than a consumer would, and it is the correction to what this paragraph said: AWCLI-19,
AWCLI-23 and AWCLI-25 carry criteria against `ctx.git.dir`, which AWCLI-13 does not build either.
Nothing behavioural was missing and WB-8's Contracts column already named the
member, so this too is a ticket-scope correction rather than a spec amendment: AWCLI-14 widened to
own `ctx.git` end to end and re-estimated 2 → 3, no rule added and no scenario written. It reached
the tickets by way of a source comment in `src/runtime/context.ts` that had recorded the gap
accurately and where no ticket reads it.

The sixth of these is not a context member at all, and it is the one where the deferral rather than
the code was the orphan. AWCLI-13 delivers `resolveWorkspaceChoice` and put the `--live-checkout`
flag that reaches it out of scope, naming AWCLI-20 — which had no requirement, no acceptance
criterion and no dependency edge for it, so the opt-in BR-014 requires would have shipped as
never-written, which is the precedent that bullet was written to avoid. AWCLI-20 is still the right
owner: WB-12 already assigns `awcli run`'s invocation surface to it through `ctx.args`, and the
boundary that decides whether a flag is awcli's or the workflow's is where BR-014's "nothing a
workflow passes selects the workspace" is enforceable rather than merely stated. So AWCLI-20 now
carries the requirement, two criteria and AWCLI-13 as a blocker, and AWCLI-21 carries stating the
resolved choice in the run's output. It stays at 3 points, because unlike AWCLI-19 and AWCLI-14 it
constructs nothing new — and because nothing here is larger than 3, a widening that did grow the
work by a point would have to be split instead. The scenario the three of them discharge is unticked
on AWCLI-13 until all three have landed.

## Tickets

| ID | Title | Pts | WB | Blocked by |
|---|---|---|---|---|
| [AWCLI-00](AWCLI-00-project-scaffolding.md) | Project scaffolding, walking skeleton | 2 | — | — |
| [AWCLI-01](AWCLI-01-freeze-context-contract.md) | Freeze the context contract | 2 | WB-1 | 00 |
| [AWCLI-02](AWCLI-02-fake-rehearsal-driver.md) | Fake agent driver | 3 | WB-1 | 01 |
| [AWCLI-03](AWCLI-03-disposal-stack.md) | Disposal stack | 3 | WB-2 | 00 |
| [AWCLI-04](AWCLI-04-cancellation-primitive.md) | Cancellation primitive, two modes | 2 | WB-2 | 03 |
| [AWCLI-05](AWCLI-05-workflow-loader.md) | Workflow loader and entry validation | 3 | WB-3 | 01 |
| [AWCLI-06](AWCLI-06-gate-chain.md) | Gate chain | 3 | WB-4 | 05 |
| [AWCLI-07](AWCLI-07-run-identity-and-lock.md) | Run identity and reclaimable lock | 2 | WB-5 | 03 |
| [AWCLI-08](AWCLI-08-run-record.md) | Run record and attribution | 2 | WB-5 | 07 |
| [AWCLI-09](AWCLI-09-durable-write-through-state.md) | Durable write-through state | 3 | WB-6 | 03, 07 |
| [AWCLI-10](AWCLI-10-scope-freezing.md) | Single-writer enforcement | 2 | WB-6 | 02, 09, 19 |
| [AWCLI-11](AWCLI-11-iteration-loop.md) | Iteration loop and termination | 3 | WB-7 | 04, 09 |
| [AWCLI-12](AWCLI-12-failure-isolation-and-drain.md) | Failure isolation and drain | 2 | WB-7 | 04, 11 |
| [AWCLI-13](AWCLI-13-worktree-provisioning.md) | Worktree provisioning | 3 | WB-8 | 03, 07 |
| [AWCLI-14](AWCLI-14-worktree-reuse-and-resume.md) | Reuse, resume, fresh start | 3 | WB-8 | 13 |
| [AWCLI-15](AWCLI-15-claude-agent-driver.md) | Claude agent driver | 3 | WB-9 | 01, 02, 13 |
| [AWCLI-16](AWCLI-16-agent-silence-and-teardown.md) | Silence, lingering, degradation | 2 | WB-9 | 04, 15 |
| [AWCLI-17](AWCLI-17-structured-output-and-reask.md) | Structured output and re-ask | 3 | WB-10 | 15 |
| [AWCLI-18](AWCLI-18-dockerfile-and-build-cache.md) | Dockerfile and build cache | 3 | WB-11 | 00 |
| [AWCLI-19](AWCLI-19-container-exec-target.md) | Sandbox scope and container target | 3 | WB-11 | 01, 03, 13, 14, 18 |
| [AWCLI-20](AWCLI-20-resolution-scaffolding-args.md) | Resolution, scaffolding, args, `--live-checkout` | 3 | WB-12 | 05, 13 |
| [AWCLI-21](AWCLI-21-logging-isolation-spend.md) | Logging, isolation, spend | 3 | WB-13 | 07, 08, 13, 15 |
| [AWCLI-22](AWCLI-22-runtime-layout-ignore-clean.md) | Runtime layout, ignore, clean | 3 | WB-14 | 07, 13, 14, 18 |
| [AWCLI-23](AWCLI-23-workspace-confined-filesystem.md) | Workspace-confined filesystem | 2 | WB-15 | 01, 13, 14, 25 |
| [AWCLI-24](AWCLI-24-resolved-environment.md) | Resolved environment | 2 | WB-16 | 01, 19, 25, 26 |
| [AWCLI-25](AWCLI-25-host-exec-target.md) | Host execution target | 2 | WB-17 | 01, 13, 14 |
| [AWCLI-26](AWCLI-26-land-frozen-surface.md) | Frozen surface's final shape | 2 | — | 01 |
| [AWCLI-27](AWCLI-27-tracked-ignore-for-session-worktrees.md) | Tracked ignore for session worktrees | 1 | — | — |
| [AWCLI-28](AWCLI-28-manifest-traceability.md) | Manifest traceability and coverage | 2 | — | — |
| [AWCLI-29](AWCLI-29-shared-filesystem-guards.md) | Shared filesystem guards | 3 | — | — |

## Order

**AWCLI-00 comes first and alone** — nothing can be built or tested before it. Once it lands,
three tickets open together: **01**, **03** and **18**, with **02** following the moment 01 does.
AWCLI-18 stays independent of everything downstream because an image is just an image; it is the
natural parallel track if a second worker exists.

The dependency graph is a DAG, not a tree — several tickets have two or three parents — so it is
drawn as waves. A ticket is workable as soon as every ticket in an earlier wave that it names as
a blocker has landed; the waves are a reading of the dependencies, not a schedule.

```
wave 0    00
wave 1    01    03    18
wave 2    02    04    05    07    26
wave 3    06    08    09    13
wave 4    11    14    15    20
wave 5    12    16    17    19    21    22    25
wave 6    10    23    24
```

The graph gained a level in run 3 of PR #15, and it is worth saying what moved it rather than
leaving a reader to diff two pictures. AWCLI-19, AWCLI-23 and AWCLI-25 each carry an acceptance
criterion against `ctx.git.dir`, and the 2026-08-28 `ctx.git` amendment gave that whole member to
AWCLI-14 — so all three gained AWCLI-14 as a blocker, 19 and 25 moved from wave 4 to wave 5, and
10, 23 and 24 followed into a wave 6. Their edges named AWCLI-13, which builds the `WorkspaceHandle`
and constructs no context around one; the picture was a wave shallower than the dependencies were.
The waves below are computed from the *Blocked by* column of the table above, and
`verify-spec-invariants.sh` check 11 asserts that they still are.

**Three tickets sit outside the waves**: AWCLI-27, AWCLI-28 and AWCLI-29. None blocks or is blocked by anything:
one edits ignore files, one reads a feature file and the test suite, one moves the forty lines of
guard code two shipped modules each keep a copy of, and all three are workable the moment someone picks them
up. Placing them in a wave would imply a dependency none has, and check 11 of
`verify-spec-invariants.sh` excludes exactly the tickets whose *Blocked by* cell is empty — so a
fourth of them joins this sentence rather than silently joining wave 0. Check 14c is what makes that
a requirement rather than a hope: it reads this sentence and the table's empty cells and fails when
they differ. AWCLI-29 was the third such ticket and reached a commit without being named here.

The multi-parent tickets, which the waves alone do not show:

| Ticket | Blocked by |
|---|---|
| AWCLI-09 | 03, 07 |
| AWCLI-10 | 02, 09, 19 |
| AWCLI-11 | 04, 09 |
| AWCLI-13 | 03, 07 |
| AWCLI-15 | 01, 02, 13 |
| AWCLI-19 | 01, 03, 13, 14, 18 |
| AWCLI-20 | 05, 13 |
| AWCLI-21 | 07, 08, 13, 15 |
| AWCLI-22 | 07, 13, 14, 18 |
| AWCLI-23 | 01, 13, 14, 25 |
| AWCLI-24 | 01, 19, 25, 26 |
| AWCLI-25 | 01, 13, 14 |

Longest chain is seven deep — **00 → 03 → 07 → 13 → 14 → 25 → 23**, and equally
**00 → 03 → 07 → 13 → 14 → 25 → 24**, **00 → 03 → 07 → 13 → 14 → 19 → 24** and
**00 → 03 → 07 → 13 → 14 → 19 → 10**. Critical paths worth naming are **00 → 01 → 05 → 06** for
refusals and **00 → 03 → 07 → 09 → 11 → 12** for the loop.

The first genuinely useful milestone is 00 + 01 + 02 + 03 + 05 + 07 + 09 + 11 — about 21 points —
a workflow that loops, carries state across passes, and rehearses against a fake agent with
nothing installed. Everything after that is capability rather than viability.

## Conventions

- One ticket is one session's work. Nothing here is larger than 3 points.
- **Status** is one of *Ready*, *In Review* or *Done*, and the middle one is not optional
  politeness. *In Review* means the work is on a branch with an open PR and review rounds still
  outstanding: criteria a reviewer has confirmed are ticked, criteria a review round has just added
  are not. *Done* means merged with every box ticked. A ticket whose PR is still being reviewed is
  never *Done*, however complete it looks from the inside — AWCLI-01 sat at *Ready* with every box
  unchecked through four review rounds, which is the failure this line exists to prevent.
- A `—` in the WB column means no work-breakdown unit owns the ticket, and five carry it: AWCLI-00,
  AWCLI-26, AWCLI-27, AWCLI-28 and AWCLI-29. The reasons are unrelated to each other. Read off the
  table by check 14b of `verify-spec-invariants.sh`, for the reason the seven-ticket sentence above
  gives: this bullet said two, then four, and the four omitted the ticket the same commit had added.
  AWCLI-27, AWCLI-28 and AWCLI-29 are the easy ones: they describe no product
  behaviour, so no unit of a breakdown of the product could have named them. AWCLI-00 is scaffolding: the work breakdown described the tool, not the
  project that holds it. AWCLI-26 is the residue of a merge — WB-1 does own the context contract,
  but the unit is already spent across AWCLI-01 and AWCLI-02, and what AWCLI-26 carries is the
  shape decisions review round 4 took after both were written. Giving it a WB number would say the
  breakdown had planned for a specification merging ahead of its code, and it had not. AWCLI-23,
  AWCLI-24 and AWCLI-25 carried a dash until PR #8's fourth review round, because the design gave
  the first two members no rules and no scenarios when the units were written, and scoped the
  third's unit (WB-11) to the container alone. BR-038, BR-039 and BR-040 closed the rule half in
  round 3; WB-15, WB-16 and WB-17 close the design half, so the scenarios those tickets carry are
  now owned at both layers rather than only at the ticket layer. AWCLI-19 keeps its original WB
  number because WB-11 did name `ctx.sandbox` — there the ticket, not the work breakdown, was the
  thing that had narrowed.
- Titles carry the bare `[AWCLI]` repo tag, so they are ready to push to a tracker unchanged.
- Every ticket closes with the same last criterion — `All tests pass, format check clean, type
  check clean.` — naming the three checks `npm run check` performs: `vitest run`,
  `prettier --check .`, and the `tsc --noEmit` that `build` runs ahead of `tsup`. It read
  `lint clean` on all 27 until PR #12's fourth review round found that awcli's own toolchain has
  no ESLint and no `lint` script of its own, so a formatting check had been counted as satisfying
  it on every ticket that shipped. AWCLI-07 was reworded there and the other 26 in the sweep that
  followed. The `commands.lint` a profile must declare (BR-006) is the *target* repository's
  linter and is a separate matter; adding one to awcli would be a change to this toolchain, and
  belongs in a ticket of its own rather than in the line describing what is already run.
- Tickets state *what* and *why*; the builder decides *how*. Specific shapes, paths and port
  signatures live in the TDD's Contracts section, referenced rather than duplicated.
- Architecture rationale is in [`../../docs/adr/`](../../docs/adr/) — seven ADRs, cited by number
  where a ticket depends on one.
