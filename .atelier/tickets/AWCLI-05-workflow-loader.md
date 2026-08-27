# AWCLI-05 — [AWCLI] Load a TypeScript workflow and validate its exports

**Points:** 3 · **Source:** WB-3 · **Status:** Ready

## Problem / Goal

The tool must import an arbitrary TypeScript file from an arbitrary repository and call its
default export. The repository may be a Python or Go project with no TypeScript toolchain, and
its `tsconfig.json` — if it has one — is configured for its own code, not for a workflow file.

## Context

Portability is the whole point of the injected-context design: one workflow file, many
repositories, nothing installed. That requires the loader to be self-sufficient and to ignore
whatever compiler configuration it finds. Entry-point validation is the first thing an author
gets wrong, so its refusal must name what was expected.

## Requirements

### Functional

- Transpile and import a TypeScript workflow file using a bundled loader, with no dependency on
  the target repository's toolchain.
- Refuse a file with no usable default export, naming the expected shape.
- Read the optional `limits` and `state` exports when present, and treat their absence as the
  documented default.
- Surface a syntax or import error in the workflow file as a clear refusal, not a stack trace
  from inside the tool.

### Non-Functional

- The target repository's compiler configuration has no effect on loading.
- Load time stays low enough that a dry run feels instant.
- No file in the target repository is written during load.

## Constraints

- No global or per-project package installation may be required.
- Validation happens before any side effect — the loader is upstream of every gate that costs
  something.

## Acceptance Criteria

- [ ] Scenario: *A workflow file with no usable entry point is refused*.
- [ ] A repository whose compiler configuration would reject the workflow file still loads it.
- [ ] Present `limits` and `state` exports are read; absent ones fall back to documented defaults.
- [ ] A syntax error in the workflow file produces a refusal naming file and position.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- Resolving which workflow file to load — AWCLI-20.
- The gates that run after loading — AWCLI-06.

## Dependencies

**Blocked by:** AWCLI-01
**Blocks:** AWCLI-06, AWCLI-20
