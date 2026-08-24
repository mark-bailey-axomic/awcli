# AWCLI-08 — [AWCLI] Record every run so it can be explained the next morning

**Points:** 2 · **Source:** WB-5 (part 2 of 2) · **Status:** Ready

## Problem / Goal

An overnight run that produced commits, cost money and touched branches must be explicable
afterwards without reading raw logs. That means an append-only record of what happened, stamped
with the versions in play, so a result can be attributed to the tool and agent that produced it.

## Context

Git and text are the source of truth (ADR-0004); the record is the index over them, not a
replacement. Version stamping matters because the agent CLI is an external subprocess that can
change under the tool without warning. Redaction of secret-shaped values is part of writing the
record, not a later pass.

## Requirements

### Functional

- Append one entry per iteration and one per run, never rewriting earlier entries.
- Stamp each entry with the tool version, the agent version, and the resolved head of the
  working copy.
- Record per-iteration outcome, agent calls made, and spend where it is known.
- Record the terminal classification of the run alongside its exit code.
- Redact values matching known secret shapes before they are written.

### Non-Functional

- Append-only: a crash mid-append must not corrupt earlier entries.
- The record is readable by a human and parseable by a script.
- An unknown value is recorded as unknown, never as zero.

## Constraints

- The record never becomes the source of truth for commits — those are read from the repository.
- Records live under the single ignored runtime path, so nothing generated here needs a new
  ignore entry.

## Acceptance Criteria

- [ ] Scenario: *Every run can be explained the next morning*.
- [ ] An entry carries tool version, agent version and head; a missing agent version is recorded
      as unknown.
- [ ] A crash between two appends leaves earlier entries intact and parseable.
- [ ] Values matching known secret shapes are absent from the written record.
- [ ] All tests pass, lint clean, type check clean.

## Out of Scope

- Per-agent log files and terminal readability — AWCLI-21.
- Spend thresholds and warnings — AWCLI-21.

## Dependencies

**Blocked by:** AWCLI-07
**Blocks:** AWCLI-21
