# AWCLI-13 — [AWCLI] Provision worktrees on deterministic branches

**Points:** 3 · **Source:** WB-8 (part 1 of 2) · **Status:** In Review

## Problem / Goal

An agent editing the operator's live checkout while they are working in it is the failure mode
that makes agentic tooling untrustworthy. Isolation must be the default, working on the live
checkout must require asking for it, and parallel agents must never share a working copy.

## Context

Workspace and execution are orthogonal axes (ADR-0003): a worktree is a workspace choice,
independent of whether execution happens on the host or in a container. Branch names are
deterministic so a resumed run can find what it made, and so an operator can recognise them.

## Requirements

### Functional

- Default to an isolated working copy per run, cut on a deterministic branch name.
- Require an explicit opt-in from the operator, on the command line, to work on the live
  checkout; a workflow cannot request it. Refuse to work there silently.
- Give each parallel slot its own working copy, so no two agents share one.
- Return the current working copy's directory, branch, head and dirty state as a `WorkspaceHandle`.
- Register each working copy for release, with preservation of its branch.

### Non-Functional

- Branch names are derived from run name and slot, and are stable across runs of the same name.
- Provisioning a working copy costs a bounded amount of time and disk for a repository of
  ordinary size. Watched at the shape rather than at a duration: provisioning issues a fixed number
  of git invocations whatever the repository holds (`Provisioning asks git a fixed number of
  questions`), and adds one working *tree* rather than a second repository, so the disk cost is the
  checkout and nothing else. A wall-clock threshold is deliberately not asserted — it would be a
  claim about the machine running the suite — and `GIT_TIMEOUT_MS` is a hang guard on one invocation,
  not a bound on the whole.
- Nothing is written to the operator's checkout outside the single runtime path `.awcli/run/`
  when isolation is in effect: their tracked files, their branch and their uncommitted work are
  untouched (BR-030). Working copies live *inside* the checkout, at
  `.awcli/run/worktrees/<run>/<slot>`, and BR-030 is what makes that acceptable — one runtime
  directory covered by one generated ignore line.

## Constraints

- The workspace axis is independent of the execution axis — a worktree must work with host or
  container execution.
- Never delete or reset a working copy holding uncommitted changes as part of provisioning.
- Never delete a branch, with the one carve-out BR-036's Exceptions now carry: a branch this
  ticket's own `git branch` cut, in an attempt whose `git worktree add` then failed, is removed by
  that same attempt. The rule is where that lives — it was written here first, which left the rule a
  reader consults saying awcli never deletes a branch automatically while this code does, and put the
  reconciliation on a ticket that will be closed. What this ticket adds is the part that is about the
  ticket: awcli's claim on that branch is provable rather than assumed, because `git branch` exits
  zero only when it created the ref and the ref points at the commit the preflight read moments
  earlier. Nothing else in provisioning deletes a branch, and no refusal names a delete that
  discards commits.
- A message an operator is meant to act on names something that is actually there. Two halves, both
  found by review with nothing stating them: a remedy is a command that *runs*, which is why every
  path in one is shell-quoted and why a path holding a character a terminal will not show is named as
  unshowable rather than pasted into a command that parses and addresses a different directory; and a
  fault raised after a `git worktree add` that *succeeded* names both things awcli leaves behind — the
  branch it cut and git's registration of the working copy — because that is the only exit where both
  are certain, and the silent version costs the next invocation four steps to rediscover. Watched by
  `verify-workspace-gate.sh` in both halves.

## Acceptance Criteria

- [x] Scenario: *The default protects my checkout*.
- [ ] Scenario: *Working on the live checkout requires asking for it*. Two of its four steps are
      here — the resolver gives a workflow no say, and provisioning puts the agent in the operator's
      checkout when the resolved choice is the live tree — and the scenario is not dischargeable
      from this ticket alone. The step that asks ("when I run it and ask for my live checkout
      myself") needs `--live-checkout` parsed off `awcli run`, which AWCLI-20 owns by the
      2026-08-28 `--live-checkout` amendment; the step that answers ("and that choice is stated
      in the run's output") needs the isolation line printed, which AWCLI-21 owns. The box stays on this ticket because a
      scenario belongs to exactly one, and this is where the mechanism it names lives. It stays
      unticked because nothing has yet watched all four steps fail and then pass: `src/cli.ts`
      parses only `--version` and `--help`, and nothing prints `WorkspaceIsolation.description`.
      Tick it when AWCLI-20 and AWCLI-21 have landed and the whole scenario has been run.
- [x] Scenario: *Parallel agents never share a working copy*.
- [x] Branch names for the same run name and slot are identical across invocations.
- [x] Provisioning asks git a fixed number of questions, whatever the repository holds, and adds one
      working tree rather than a second repository. The bounded-cost requirement above had no
      criterion and nothing watching it — no test, no benchmark, no gate mutation — so it would have
      shipped on the strength of the sentence. Asserted as a count (six invocations, identical for a
      one-commit repository and a nine-commit one with eight extra branches) and as the worktree's
      `.git` being a pointer file. No gate mutation covers this one, and that is worth saying: the
      wrong implementations it guards against are extra calls and a walk of the history, and a
      substitution that adds a plausible extra invocation is not a wrong implementation of any line
      that is there. The count is the guard.
- [x] All tests pass, format check clean, type check clean.

## Out of Scope

- Reuse across iterations, resume and fresh start — AWCLI-14.
- Branch collection — AWCLI-22.
- **Exposing the working copy to the workflow.** The functional requirement above is delivered as
  far as a `WorkspaceHandle`, which carries `dir`, `branch`, `head` and `dirty`; nothing constructs
  a context around one, so `ctx.git` stays unbuilt and `supports("git")` answers false. `GitApi`
  also declares `log`, `diff` and `commit`, which no unit had claimed at all, and `supports()`
  answers per member (BR-033) — so a half-built `git` would lie in one direction or the other.
  **AWCLI-14** owns the member end to end, by the 2026-08-28 `ctx.git` amendment. Named here
  rather than left to a docblock, because a requirement half that no ticket owns is a half that
  ships as never-written — the AWCLI-07 precedent.
- **Writing the generated ignore line.** BR-030 allows working copies inside the checkout because
  one line covers them, and that line is unwritten: until it exists, `.awcli/` shows up untracked
  in the operator's repository and `git add -A` stages each worktree as an *embedded git
  repository* — one gitlink index entry for the whole tree, with git's own advice printed alongside —
  so what a commit puts in the operator's history is an unusable pseudo-submodule rather than the
  files under it, and the way out is `git rm --cached <path>`. **AWCLI-22** owns the runtime layout
  and the ignore entry. The suite watches the window rather than hiding it: the test helper filters
  only `.git`, and *The default protects my checkout* asserts `.awcli` and `?? .awcli/` positively as
  the one new entry — so it goes red the day AWCLI-22's ignore line lands, which is the intended
  handoff.
- **The `--live-checkout` flag itself, and printing the isolation line.** BR-014 puts the opt-in on
  the command line and the scenario ends "and that choice is stated in the run's output"; this
  ticket delivers the resolver and the sentence, one layer below both. `src/cli.ts` parses only
  `--version` and `--help`, and nothing prints `WorkspaceIsolation.description`. **AWCLI-20** owns
  parsing `--live-checkout` off `awcli run` and answering it through `resolveWorkspaceChoice` — it
  is the only ticket that turns this command line into run configuration, and it now carries a
  functional requirement, two acceptance criteria and this ticket as a blocker, by the 2026-08-28
  `--live-checkout` amendment. **AWCLI-21** owns the run's output and now carries the requirement
  to state the workspace choice there. Neither was true when this bullet was first written: naming a ticket that
  owns no part of the work is the AWCLI-07 precedent this bullet was written to avoid, not an
  escape from it.

## Notes

Four rows of the `## Amendments` section in
[`../design/agentic-workflow-cli-rules.md`](../design/agentic-workflow-cli-rules.md) move through
this ticket; several rows share their date, so each is cited by its subject rather than by its
position or by a count of them. This sentence said *two* while it was being written in the same
commit as the third and fourth, three lines above the clause warning against citing rows by count —
which is the class of defect five of the last six review rounds have found, and the reason the four
are listed rather than totalled.

The `--live-checkout` row re-owns the flag onto AWCLI-20 and the run's isolation line onto
AWCLI-21, and unticks the scenario criterion above. The BR-030 row records that the third
non-functional criterion was reconciled with BR-030 — it read "nothing is written to the operator's
checkout when isolation is in effect" and now carves out `.awcli/run/`, because BR-030 requires all
mutable run data beneath one runtime directory and that directory is inside the repository. The
carve-out was written after the code that needed it, which is why it is recorded rather than left as
an in-place rewrite. No rule and no scenario text changed for either.

The BR-036 row moves the failed-add branch rollback into that rule's Exceptions, so the Constraints
below cite BR-036 rather than standing in for it. The wrong-counts row adds the constraint for the
two message properties the code already had and no ticket stated: a remedy is a command that runs,
and a fault raised after a successful `git worktree add` names the branch and the registration it
leaves behind. Both changed this ticket; neither changed a rule or a scenario.

## Dependencies

**Blocked by:** AWCLI-03, AWCLI-07
**Blocks:** AWCLI-14, AWCLI-15, AWCLI-19, AWCLI-20, AWCLI-21, AWCLI-22, AWCLI-23, AWCLI-25
