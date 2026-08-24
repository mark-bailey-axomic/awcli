# awcli — implementation tickets

22 tickets, 57 points, derived from the 14-unit work breakdown in
[`../design/agentic-workflow-cli-tdd.md`](../design/agentic-workflow-cli-tdd.md). The seven
5-point units were each split into a 3 and a 2; WB-5 split into two 2-point tickets, which is
where the extra point over the design's 56 comes from — separating the lock from the record
revealed work the single estimate had compressed.

Every one of the 60 approved BDD scenarios appears as an acceptance criterion on exactly one
ticket. Acceptance criteria written in *italics* are scenario names from
[`../design/agentic-workflow-cli-bdd.feature`](../design/agentic-workflow-cli-bdd.feature) —
those are the tests, verbatim.

## Tickets

| ID | Title | Pts | WB | Blocked by |
|---|---|---|---|---|
| [AWCLI-01](AWCLI-01-freeze-context-contract.md) | Freeze the context contract | 2 | WB-1 | — |
| [AWCLI-02](AWCLI-02-fake-rehearsal-driver.md) | Fake agent driver | 3 | WB-1 | 01 |
| [AWCLI-03](AWCLI-03-disposal-stack.md) | Disposal stack | 3 | WB-2 | — |
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
| [AWCLI-18](AWCLI-18-dockerfile-and-build-cache.md) | Dockerfile and build cache | 3 | WB-11 | — |
| [AWCLI-19](AWCLI-19-container-exec-target.md) | Container execution target | 2 | WB-11 | 03, 13, 18 |
| [AWCLI-20](AWCLI-20-resolution-scaffolding-args.md) | Resolution, scaffolding, args | 3 | WB-12 | 05 |
| [AWCLI-21](AWCLI-21-logging-isolation-spend.md) | Logging, isolation, spend | 3 | WB-13 | 07, 08, 15 |
| [AWCLI-22](AWCLI-22-runtime-layout-ignore-clean.md) | Runtime layout, ignore, clean | 3 | WB-14 | 07, 13, 14, 18 |

## Order

Four tickets are unblocked from day one: **01**, **03**, **18** — and **02** the moment 01 lands.
AWCLI-18 is independent of everything because an image is just an image; it is the natural
parallel track if a second worker exists.

```
01 ─┬─ 02 ─┬────────────────────────── 10
    │      └── 15 ─┬─ 16
    └── 05 ─┬─ 06  ├─ 17
            └── 20 └──────── 21
03 ─┬─ 04 ─┬─ 11 ─── 12
    ├─ 07 ─┼─ 08 ──────────── 21
    │      ├─ 09 ─┬─ 10
    │      │      └─ 11
    │      └─ 13 ─┬─ 14 ─── 22
    └───────────  └─ 19
18 ─┬─ 19
    └─ 22
```

Critical path: **01 → 05 → 06** for refusals, and **03 → 07 → 09 → 11 → 12** for the loop. The
first genuinely useful milestone is 01 + 02 + 03 + 05 + 07 + 09 + 11 — a workflow that loops,
carries state and rehearses against a fake agent with nothing installed.

## Conventions

- One ticket is one session's work. Nothing here is larger than 3 points.
- Titles carry the bare `[AWCLI]` repo tag, so they are ready to push to a tracker unchanged.
- Tickets state *what* and *why*; the builder decides *how*. Specific shapes, paths and port
  signatures live in the TDD's Contracts section, referenced rather than duplicated.
- Architecture rationale is in [`../../docs/adr/`](../../docs/adr/) — seven ADRs, cited by number
  where a ticket depends on one.
