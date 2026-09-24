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
- Call the workflow's default export with the injected context and nothing else. This is the moment
  a workflow's own code first runs inside awcli's process, so it is where the channels a workflow
  has are decided — a second argument, or a module of awcli's the loader leaves reachable, is a
  channel no later unit can close. The workspace axis is the one BR-014 makes a rule about: the
  `WorkspaceChoice` is decided at the command line (AWCLI-20) from the operator's flag and handed
  down, and nothing here re-derives it or hands a workflow anything that could.
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
- [ ] A loaded workflow is called with the injected context and nothing else: no second argument,
      and nothing the loader adds by which it could reach awcli's own decisions — asserted over what
      the loader passes, not by inspection. The workspace axis is the named case (BR-014).
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- Resolving which workflow file to load — AWCLI-20.
- The gates that run after loading — AWCLI-06.
- Deciding the workspace axis, and refusing a live checkout asked for without consent — AWCLI-13
  owns `resolveWorkspaceChoice`, and AWCLI-20 is the flag boundary that calls it. What this ticket
  owns is that loading a workflow adds no channel to that decision.

## Notes

The call-site requirement and criterion above arrived by way of the 2026-09-02 ticket-scope row of
the `## Amendments` section in
[`../design/agentic-workflow-cli-rules.md`](../design/agentic-workflow-cli-rules.md).
`workspace.ts`'s `LiveCheckoutConsent` docblock had deferred the rule to AWCLI-20 as "where a
workflow first gets loaded in-process", which is this ticket — AWCLI-20's own Out of Scope defers
loading here, and this ticket blocks it — and to a requirement AWCLI-20 does not carry. The window
this opens is the reason the rule belongs here; the flag boundary and `ctx.sandbox` halves stay on
AWCLI-20 and AWCLI-19, which already carry them.

## Dependencies

**Blocked by:** AWCLI-01
**Blocks:** AWCLI-06, AWCLI-20
