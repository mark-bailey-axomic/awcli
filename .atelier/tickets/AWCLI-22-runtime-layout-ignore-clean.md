# AWCLI-22 — [AWCLI] One runtime path, one ignore line, and a clean that only removes what is safe

**Points:** 3 · **Source:** WB-14 · **Status:** Ready

## Problem / Goal

A tool that keeps adding ignored paths as it grows forces every repository to update its ignore
file on every upgrade. Putting all mutable state under a single runtime path makes that a
one-time, one-line change — and means a new runtime path in a later version needs no ignore
change at all.

## Context

Three generated artifacts are committed deliberately: the Dockerfile, the configuration, and the
context declaration. Everything mutable lives under one runtime path. The ignore entry is written
once and then left alone, because an operator who chose to track or untrack something should not
have that decision reverted by the next run.

The configuration written here is what the profile gate then checks. BR-006 makes all five fields
awcli defines required, and refuses at startup whether or not a workflow reads them, so a
configuration written without them would leave `awcli init` producing a repository `awcli run`
immediately refuses. The five are named in the TDD's command table; this ticket is where they get
written.

Where that runtime path is anchored is part of what makes the one ignore line work. `git rev-parse
--git-dir` succeeds from any directory inside a repository, so a `--repo` pointing at a
subdirectory would put a second runtime directory beside it — and a single root-anchored ignore
entry would not cover it, which is the premise BR-030 rests on. AWCLI-13 provisions the first
thing to actually live under that path, so this is the ticket where the anchor has to be decided
rather than assumed.

## Requirements

### Functional

- Write the repository's initial layout: Dockerfile, configuration, context declaration, and the
  single ignore entry.
- Write all five required profile fields into the configuration — `commands.test`,
  `commands.build`, `commands.lint`, `paths.docs`, `paths.standards` — so an initialised
  repository passes the profile gate as initialised (BR-006, AWCLI-06).
- Write the ignore entry once and never rewrite it.
- Place all mutable state — run state, records, locks, logs, working copies — under one runtime
  path, anchored at the repository root however the repository was named, so the single ignore
  entry covers every run's data (BR-030).
- Provide a clean command that releases leftovers and, on request, collects branches.
- Never remove a branch holding commits that exist nowhere else.

### Non-Functional

- A later version adding a new kind of runtime file requires no ignore change.
- Clean is safe to run while another run holds a lock — it skips what is live and says so.
- Initialisation is idempotent: running it twice changes nothing the second time.

## Constraints

- The three committed artifacts are never added to the ignore entry.
- Clean never touches unmerged commits; branch collection is opt-in and reports what it kept.

## Acceptance Criteria

- [ ] Scenario: *The generated ignore entry is written once and then left alone*.
- [ ] Scenario: *Collecting tidies only what is safe to remove*.
- [ ] A freshly initialised repository passes AWCLI-06's profile gate with no further editing —
      all five required fields are present, asserted against that gate rather than by inspection.
- [ ] The three committed artifacts are absent from the ignore entry after initialisation.
- [ ] Adding a new runtime file kind requires no ignore change — asserted by test.
- [ ] Re-running initialisation over an existing layout changes nothing.
- [ ] Clean run against a live run skips the locked run and reports it.
- [ ] Naming a subdirectory of a repository puts the runtime path at the repository root, not
      beside the subdirectory — asserted by running against a real repository, not by inspection.
- [ ] The suite can observe a run dirtying the operator's repository: the test helper no longer
      filters the runtime path out of `git status` or directory listings, so the ignore entry is
      what makes the assertion pass rather than the helper.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- Branch naming and provisioning — AWCLI-13, AWCLI-14.

## Dependencies

**Blocked by:** AWCLI-07, AWCLI-13, AWCLI-14, AWCLI-18 (Dockerfile content)
**Blocks:** None
