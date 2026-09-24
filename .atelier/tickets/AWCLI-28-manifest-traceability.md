# AWCLI-28 — [AWCLI] Link every scenario to the test that runs it, and let the link break loudly

**Points:** 2 · **Source:** new — review of PR #15, run 1 (S-002 there: the empty manifest traceability) · **Status:** Ready

## Problem / Goal

`design/agentic-workflow-cli-spec-manifest.yaml` carries `traceability: []` and a `validation`
block whose coverage counts are all zero, with `gaps` and `drift` empty — while every ticket marked
done has tests that exist and pass. The manifest therefore reports nothing about a
relationship that is real, and its empty `gaps` list reads as "no gaps found" rather than "never
looked".

Today the link from a BDD scenario to the test that runs it is asserted only by a test name
matching the scenario's feature text by hand. That works exactly until someone renames a scenario
or a test, at which point the scenario silently has no test and every artifact that would have
said so is empty.

## Context

The tickets already do half the work: acceptance criteria written in *italics* are scenario names
from `design/agentic-workflow-cli-bdd.feature`, verbatim, and every one of the 78 scenarios appears
on exactly one ticket. So scenario → ticket is recorded and maintained. What is missing is
scenario → test, and the check that the pair still agree.

This is debt that predates AWCLI-13 and is not caused by it; the review that surfaced it noted it
as surrounding context rather than a defect in that PR. It is worth a ticket now because the cost
grows with every ticket that lands: a manifest that has stayed empty across every completed ticket
is a manifest nobody will trust to be populated at twenty. No count of them here on purpose — the
number this ticket was written with was already one behind by the time it was committed.

Before building anything bespoke, check what `/atelier:spec` already does — if it can populate
traceability and coverage from the feature file and the test names, this ticket is configuration
and a gate rather than new machinery, and should be scoped that way.

## Requirements

### Functional

- Populate `traceability` so each scenario names the test that runs it and the ticket that owns it.
- Populate `validation.coverage` with real counts, and `validation.last_run` with when they were
  measured.
- Fail loudly when a scenario has no test, or a traced test no longer exists — an unmatched
  scenario appears in `gaps`, and a broken link is a check failure rather than a silent zero.
- Record whether the linkage was produced by `/atelier:spec` or by something written here, so a
  later reader knows what maintains it.

### Non-Functional

- Renaming a scenario or a test breaks the check rather than the link.
- Regenerating the manifest over an unchanged tree changes nothing.

## Constraints

- The feature file and the rules file are approved documents — this ticket reads them and never
  rewrites them to make a link match.
- Pending PM re-approval of the amended rules and scenarios is unaffected: tracing a scenario says
  nothing about whether it is approved.

## Acceptance Criteria

- [ ] Every scenario in the feature file is either traced to a test or listed in `gaps` — no
      scenario is silently absent from both.
- [ ] `validation.coverage` and `validation.last_run` reflect a real run, asserted against the
      test suite rather than written by hand.
- [ ] Renaming a scenario without updating its test fails the check, and the failure names the
      scenario — asserted by test.
- [ ] Renaming a traced test without updating the manifest fails the same way.
- [ ] Re-running over an unchanged tree produces no diff.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- PM re-approval of the amended rules and scenarios — a separate gate, tracked in the rules file's
  `## Amendments`.
- Writing new scenarios for behaviour that has none.

## Dependencies

**Blocked by:** None
**Blocks:** None
