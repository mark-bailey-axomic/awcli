# AWCLI-20 — [AWCLI] Resolve workflows project-first, scaffold new ones, pass arguments through

**Points:** 3 · **Source:** WB-12 · **Status:** Ready

## Problem / Goal

The payoff of the injected-context design is portability: one workflow, many repositories,
nothing installed. That needs a resolution order an operator can predict — a repository's own
workflow wins, the shared library is the fallback, and an explicit path always wins outright.

## Context

A global library plus project overrides was chosen so a workflow written once can run against a
Python or Go repository that has no package manager for it. The library must stay clean enough to
sync between machines with a git remote, which matters because the Windows path is WSL2 and
therefore a separate home directory (ADR-0007).

## Requirements

### Functional

- Resolve a workflow by name: the repository's own workflows first, then the shared library.
- Honour an explicit path unconditionally, bypassing resolution.
- Scaffold a new workflow from a template, into the shared library or into a repository.
- Pass invocation arguments through to the workflow as a plain string record.
- Keep the shared library free of anything that cannot be synced between machines.
- Recognise awcli's own flags on `awcli run` and keep them out of what reaches the workflow.
  `--live-checkout` is consumed here and answered by `resolveWorkspaceChoice`; it never appears in
  the `--arg` record. This is the boundary that decides whether a flag is awcli's or the workflow's,
  and it is therefore the only place BR-014's "nothing a workflow passes selects the workspace" is
  enforceable rather than merely stated.

### Non-Functional

- Resolution order is reported when a workflow is chosen, so shadowing is never a surprise.
- A repository in another language needs nothing installed for a workflow to run against it.
- Scaffolded workflows run immediately, without editing.

## Constraints

- The shared library contains workflows only — no run state, no logs, no machine-specific paths.
- A workflow reaching past the injected context for extra capability takes on that requirement
  itself; the tool does not install it.
- `WorkspaceRequest.git` is never populated from anything a workflow or an invocation can reach.
  It is the test seam for the three failures a real repository cannot stage — git absent from the
  machine, git hanging, a `cwd` that has gone — and it out-ranks every guard in `workspace.ts`: a
  supplied runner answers `rev-parse --show-toplevel`, and the root it returns is what the layout,
  the `mkdir`s, the ancestor guard and the runtime-boundary check are all derived from, while the
  real filesystem calls execute against whatever path it named. `LiveCheckoutConsent` is the
  comparison that makes this a constraint rather than a note: that field spends sixty lines making
  it impossible for a request object to decide the workspace axis, and this one decides strictly
  more with a plain optional function. What keeps it safe today is only a fact about the call
  sites — nothing routes workflow input into `acquireWorkspace`, because `ctx.sandbox` is
  unbuilt — and this ticket is the boundary that decides which of an invocation's inputs become
  awcli's own. So the rule is written here, beside the `--live-checkout` one, for the same reason.

## Acceptance Criteria

- [ ] Scenario: *A project's own workflow shadows the shared one*.
- [ ] Scenario: *The shared workflow is used when the project has none*.
- [ ] Scenario: *An explicit path is always honoured*.
- [ ] Scenario: *The workflow library stays clean enough to sync between machines*.
- [ ] Scenario: *A repository in another language needs nothing installed*.
- [ ] Scenario: *A workflow that reaches past the context takes on that requirement itself*.
- [ ] `awcli run` with `--live-checkout` resolves the workspace to the operator's live checkout and
      without it to a worktree, both through AWCLI-13's `resolveWorkspaceChoice` — not by a second
      decision taken here.
- [ ] `--live-checkout` is absent from `ctx.args`, and no `--arg` value selects the workspace on any
      spelling (BR-014).
- [ ] No invocation input reaches `WorkspaceRequest.git`: the runner awcli passes is
      `systemGitRunner`, decided in this unit and derived from nothing a caller supplied —
      asserted by a test that watches which runner an acquisition is given, not by inspection.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- Loading and validating the resolved file — AWCLI-05.
- Writing the repository's own configuration — AWCLI-22.
- Provisioning the working copy the resolved choice names, and the refusals that guard it —
  AWCLI-13, which owns `resolveWorkspaceChoice` itself.
- Stating the resolved choice in the run's output — AWCLI-21. Between them those two tickets and
  this one discharge the scenario *Working on the live checkout requires asking for it*, which
  AWCLI-13 carries and leaves unticked until all three have landed.

## Notes

Widened to own the `--live-checkout` flag by the 2026-08-28 `--live-checkout` row of the
`## Amendments` section in
[`../design/agentic-workflow-cli-rules.md`](../design/agentic-workflow-cli-rules.md). AWCLI-13
had deferred the flag here in prose while this ticket carried no requirement, no criterion and no
dependency edge for it; the requirement, the two criteria and the AWCLI-13 blocker above are what
make the deferral true. WB-12's Contracts column already names `ctx.args`, so the invocation surface
of `awcli run` was assigned to this unit — what was missing is that the surface has two halves, and
only the half whose values are forwarded had an owner.

**Points stay at 3, and that is a decision rather than an omission.** The two precedents for a
widening — AWCLI-19 for `ctx.sandbox` and AWCLI-14 for `ctx.git` — were both re-estimated 2 → 3
because each took on constructing something that did not exist: a `Scope` object, and `GitApi`'s
`log`, `diff` and `commit`. Nothing is constructed here. This ticket already has to walk `awcli
run`'s command line for `--arg`; what it gains is one more recognised flag, routed into a resolver
AWCLI-13 has already built and tested, plus an assertion about what is *not* in a record it already
builds. `README.md` also caps a ticket at 3 points — one session's work — so a widening that did
grow the work by a point would have to be split rather than re-estimated, and this one does not.

## Dependencies

**Blocked by:** AWCLI-05, AWCLI-13
**Blocks:** None
