# awcli — implementation tickets

27 tickets, 68 points, derived from the 17-unit work breakdown in
[`../design/agentic-workflow-cli-tdd.md`](../design/agentic-workflow-cli-tdd.md). Five of the seven
5-point units were split into a 3 and a 2; WB-5 split into two 2-point tickets and WB-11 into two
3-point ones, which is where two of the six extra points over the design's 62 come from —
separating the lock from the record, and the sandbox scope from the container inside it, each
revealed work the single estimate had compressed. AWCLI-00 accounts for the other two: project
scaffolding the work breakdown never named, because a design document assumes a project exists.
AWCLI-26 accounts for the last two, and for a different reason again: no unit was missing and no
estimate was wrong — PR #8 merged the specification of the context surface's final shape without the
code that implements it, so the work exists as a ticket only because a merge left it behind.

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
eighteen scenarios added and one of the sixty rewritten. So 31 of the 40 rules and 59 of the 78
scenarios stand as approved, and 9 rules and 19 scenarios are pending.

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

The converse does not hold, and it applies to four tickets: AWCLI-00, AWCLI-03, AWCLI-15 and
AWCLI-18 carry no scenario at all. Scaffolding, the disposal stack, the agent driver and the
image build are machinery whose observable behaviour is asserted on the tickets built on top of
them — 04, 16, 17, 19 and 21. It was six tickets until BR-038 and BR-039 were added: `ctx.fs`
and `ctx.env` were the only two of the twelve context members the TDD governed with no business
rule — a dash in its Rules column — and no scenario exercised either, so AWCLI-23 and AWCLI-24
derived their criteria from the frozen declaration instead. Those two rules close that gap, each
with scenarios of its own; the declaration still supplies what the scenarios do not state. Exact
counts per amendment are in the rules file's `## Amendments` section rather than repeated here.

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
| [AWCLI-14](AWCLI-14-worktree-reuse-and-resume.md) | Reuse, resume, fresh start | 2 | WB-8 | 13 |
| [AWCLI-15](AWCLI-15-claude-agent-driver.md) | Claude agent driver | 3 | WB-9 | 01, 02, 13 |
| [AWCLI-16](AWCLI-16-agent-silence-and-teardown.md) | Silence, lingering, degradation | 2 | WB-9 | 04, 15 |
| [AWCLI-17](AWCLI-17-structured-output-and-reask.md) | Structured output and re-ask | 3 | WB-10 | 15 |
| [AWCLI-18](AWCLI-18-dockerfile-and-build-cache.md) | Dockerfile and build cache | 3 | WB-11 | 00 |
| [AWCLI-19](AWCLI-19-container-exec-target.md) | Sandbox scope and container target | 3 | WB-11 | 01, 03, 13, 18 |
| [AWCLI-20](AWCLI-20-resolution-scaffolding-args.md) | Resolution, scaffolding, args | 3 | WB-12 | 05 |
| [AWCLI-21](AWCLI-21-logging-isolation-spend.md) | Logging, isolation, spend | 3 | WB-13 | 07, 08, 15 |
| [AWCLI-22](AWCLI-22-runtime-layout-ignore-clean.md) | Runtime layout, ignore, clean | 3 | WB-14 | 07, 13, 14, 18 |
| [AWCLI-23](AWCLI-23-workspace-confined-filesystem.md) | Workspace-confined filesystem | 2 | WB-15 | 01, 13, 25 |
| [AWCLI-24](AWCLI-24-resolved-environment.md) | Resolved environment | 2 | WB-16 | 01, 19, 25, 26 |
| [AWCLI-25](AWCLI-25-host-exec-target.md) | Host execution target | 2 | WB-17 | 01, 13 |
| [AWCLI-26](AWCLI-26-land-frozen-surface.md) | Frozen surface's final shape | 2 | — | 01 |

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
wave 3    06    08    09    13    20
wave 4    11    14    15    19    25
wave 5    10    12    16    17    21    22    23    24
```

The multi-parent tickets, which the waves alone do not show:

| Ticket | Blocked by |
|---|---|
| AWCLI-09 | 03, 07 |
| AWCLI-10 | 02, 09, 19 |
| AWCLI-11 | 04, 09 |
| AWCLI-13 | 03, 07 |
| AWCLI-15 | 01, 02, 13 |
| AWCLI-19 | 01, 03, 13, 18 |
| AWCLI-21 | 07, 08, 15 |
| AWCLI-22 | 07, 13, 14, 18 |
| AWCLI-23 | 01, 13, 25 |
| AWCLI-24 | 01, 19, 25, 26 |
| AWCLI-25 | 01, 13 |

Longest chain is six deep — **00 → 03 → 07 → 13 → 14 → 22**, and equally
**00 → 03 → 07 → 13 → 25 → 23**, **00 → 03 → 07 → 13 → 25 → 24**,
**00 → 03 → 07 → 13 → 19 → 24** and **00 → 03 → 07 → 13 → 19 → 10**. Critical paths worth
naming are **00 → 01 → 05 → 06** for refusals and **00 → 03 → 07 → 09 → 11 → 12** for the loop.

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
- A `—` in the WB column means no work-breakdown unit owns the ticket, and two carry it for
  unrelated reasons. AWCLI-00 is scaffolding: the work breakdown described the tool, not the
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
  check clean.` — and those three are exactly what `npm run check` runs: `prettier --check .`,
  `vitest run`, and the `tsc --noEmit` that `build` runs ahead of `tsup`. It read `lint clean`
  on all 27 until PR #12's fourth review round, and no ticket had ever been held to it: there is
  no ESLint in the repository and no `lint` script, so a formatting check had been standing in
  for a linter on every ticket that shipped. The wording now names the gate that exists. Adding
  a real linter is a change to the toolchain and belongs in a ticket of its own, not in the line
  that describes what is already run.
- Tickets state *what* and *why*; the builder decides *how*. Specific shapes, paths and port
  signatures live in the TDD's Contracts section, referenced rather than duplicated.
- Architecture rationale is in [`../../docs/adr/`](../../docs/adr/) — seven ADRs, cited by number
  where a ticket depends on one.
