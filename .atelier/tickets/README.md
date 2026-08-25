# awcli — implementation tickets

25 tickets, 63 points, derived from the 14-unit work breakdown in
[`../design/agentic-workflow-cli-tdd.md`](../design/agentic-workflow-cli-tdd.md). The seven
5-point units were each split into a 3 and a 2; WB-5 split into two 2-point tickets, which is
where one of the extra points over the design's 56 comes from — separating the lock from the
record revealed work the single estimate had compressed. AWCLI-00 accounts for two more: project
scaffolding the work breakdown never named, because a design document assumes a project exists.
The remaining four are AWCLI-23 and AWCLI-24 at two points each, delivering the two context
members the work breakdown left unowned.

Every one of the 68 approved BDD scenarios appears as an acceptance criterion on exactly one
ticket. Acceptance criteria written in *italics* are scenario names from
[`../design/agentic-workflow-cli-bdd.feature`](../design/agentic-workflow-cli-bdd.feature) —
those are the tests, verbatim.

The converse does not hold, and it applies to four tickets: AWCLI-00, AWCLI-03, AWCLI-15 and
AWCLI-18 carry no scenario at all. Scaffolding, the disposal stack, the agent driver and the
image build are machinery whose observable behaviour is asserted on the tickets built on top of
them — 04, 16, 17, 19 and 21. It was six tickets until BR-038 and BR-039 were added: `ctx.fs`
and `ctx.env` were the only two of the twelve context members the TDD governed with no business
rule — a dash in its Rules column — and no scenario exercised either, so AWCLI-23 and AWCLI-24
derived their criteria from the frozen declaration instead. Those two rules and their eight
scenarios close that gap; the declaration still supplies what the scenarios do not state.

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
| [AWCLI-10](AWCLI-10-scope-freezing.md) | Scope freezing | 2 | WB-6 | 02, 09 |
| [AWCLI-11](AWCLI-11-iteration-loop.md) | Iteration loop and termination | 3 | WB-7 | 04, 09 |
| [AWCLI-12](AWCLI-12-failure-isolation-and-drain.md) | Failure isolation and drain | 2 | WB-7 | 04, 11 |
| [AWCLI-13](AWCLI-13-worktree-provisioning.md) | Worktree provisioning | 3 | WB-8 | 03, 07 |
| [AWCLI-14](AWCLI-14-worktree-reuse-and-resume.md) | Reuse, resume, fresh start | 2 | WB-8 | 13 |
| [AWCLI-15](AWCLI-15-claude-agent-driver.md) | Claude agent driver | 3 | WB-9 | 01, 02, 13 |
| [AWCLI-16](AWCLI-16-agent-silence-and-teardown.md) | Silence, lingering, degradation | 2 | WB-9 | 04, 15 |
| [AWCLI-17](AWCLI-17-structured-output-and-reask.md) | Structured output and re-ask | 3 | WB-10 | 15 |
| [AWCLI-18](AWCLI-18-dockerfile-and-build-cache.md) | Dockerfile and build cache | 3 | WB-11 | 00 |
| [AWCLI-19](AWCLI-19-container-exec-target.md) | Container execution target | 2 | WB-11 | 03, 13, 18 |
| [AWCLI-20](AWCLI-20-resolution-scaffolding-args.md) | Resolution, scaffolding, args | 3 | WB-12 | 05 |
| [AWCLI-21](AWCLI-21-logging-isolation-spend.md) | Logging, isolation, spend | 3 | WB-13 | 07, 08, 15 |
| [AWCLI-22](AWCLI-22-runtime-layout-ignore-clean.md) | Runtime layout, ignore, clean | 3 | WB-14 | 07, 13, 14, 18 |
| [AWCLI-23](AWCLI-23-workspace-confined-filesystem.md) | Workspace-confined filesystem | 2 | — | 01, 13, 19 |
| [AWCLI-24](AWCLI-24-resolved-environment.md) | Resolved environment | 2 | — | 01, 19 |

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
wave 2    02    04    05    07
wave 3    06    08    09    13    20
wave 4    10    11    14    15    19
wave 5    12    16    17    21    22    23    24
```

The multi-parent tickets, which the waves alone do not show:

| Ticket | Blocked by |
|---|---|
| AWCLI-09 | 03, 07 |
| AWCLI-10 | 02, 09 |
| AWCLI-11 | 04, 09 |
| AWCLI-13 | 03, 07 |
| AWCLI-15 | 01, 02, 13 |
| AWCLI-19 | 03, 13, 18 |
| AWCLI-21 | 07, 08, 15 |
| AWCLI-22 | 07, 13, 14, 18 |
| AWCLI-23 | 01, 13, 19 |
| AWCLI-24 | 01, 19 |

Longest chain is six deep — **00 → 03 → 07 → 13 → 14 → 22**, and equally
**00 → 03 → 07 → 13 → 19 → 24** and **00 → 03 → 07 → 13 → 19 → 23**. Critical paths worth
naming are **00 → 01 → 05 → 06** for refusals and **00 → 03 → 07 → 09 → 11 → 12** for the loop.

The first genuinely useful milestone is 00 + 01 + 02 + 03 + 05 + 07 + 09 + 11 — about 21 points —
a workflow that loops, carries state across passes, and rehearses against a fake agent with
nothing installed. Everything after that is capability rather than viability.

## Conventions

- One ticket is one session's work. Nothing here is larger than 3 points.
- A `—` in the WB column means no work-breakdown unit owns the ticket. AWCLI-00 is one: the work
  breakdown described the tool, not the project that holds it. AWCLI-23 and AWCLI-24 are the
  others, for the reason given above — the design gave their two members no rules and no
  scenarios when the units were written, so none was written to deliver them. BR-038 and BR-039
  govern the members now; the units were never revisited.
- Titles carry the bare `[AWCLI]` repo tag, so they are ready to push to a tracker unchanged.
- Tickets state *what* and *why*; the builder decides *how*. Specific shapes, paths and port
  signatures live in the TDD's Contracts section, referenced rather than duplicated.
- Architecture rationale is in [`../../docs/adr/`](../../docs/adr/) — seven ADRs, cited by number
  where a ticket depends on one.
