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

### Non-Functional

- Resolution order is reported when a workflow is chosen, so shadowing is never a surprise.
- A repository in another language needs nothing installed for a workflow to run against it.
- Scaffolded workflows run immediately, without editing.

## Constraints

- The shared library contains workflows only — no run state, no logs, no machine-specific paths.
- A workflow reaching past the injected context for extra capability takes on that requirement
  itself; the tool does not install it.

## Acceptance Criteria

- [ ] Scenario: *A project's own workflow shadows the shared one*.
- [ ] Scenario: *The shared workflow is used when the project has none*.
- [ ] Scenario: *An explicit path is always honoured*.
- [ ] Scenario: *The workflow library stays clean enough to sync between machines*.
- [ ] Scenario: *A repository in another language needs nothing installed*.
- [ ] Scenario: *A workflow that reaches past the context takes on that requirement itself*.
- [ ] All tests pass, lint clean, type check clean.

## Out of Scope

- Loading and validating the resolved file — AWCLI-05.
- Writing the repository's own configuration — AWCLI-22.

## Dependencies

**Blocked by:** AWCLI-05
**Blocks:** None
