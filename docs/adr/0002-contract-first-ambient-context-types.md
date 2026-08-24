# ADR-0002: The Context Contract Is Hand-Authored Ambient Types, Frozen First

**Date:** 2026-08-24
**Status:** Accepted
**Context:** [TDD](../../.atelier/design/agentic-workflow-cli-tdd.md)

## Decision

The context's type surface is a hand-authored declaration file that awcli writes into the target
repository, and the runtime implementation is checked against it at compile time. It is frozen as an
artifact before the machinery behind it is built.

## Context

awcli injects the context rather than being imported, which removes the per-project install (grill
Q4) but leaves the author with nothing to type `ctx` against. Target repositories may have no
`package.json`, no `node_modules`, and therefore no `@types/node` — so *any* import in a workflow
file is an editor error (grill Q5). Types must arrive without a package install.

Separately, BR-033 requires the contract to be settled before its implementation, because workflows
are committed code and a contract settled late is a contract broken often.

## Alternatives Considered

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **Generated ambient `.d.ts`, hand-authored as the contract** | No install, no `package.json`, any language repo; regenerated from the binary so it cannot drift; doubles as the frozen artifact P0-13 needs | A generated file in the repo; stale after an upgrade until regenerated | ✅ **Chosen** |
| **Types-only devDependency** | Standard tooling, lockfile-pinned, editor-agnostic | Requires `package.json` + install in every target repo, excluding non-Node repos — the premise the whole design rests on | ❌ Rejected |
| **Generate `.d.ts` from runtime types** | Single source of truth, no duplication | Generation must run to be correct, so the contract follows the implementation instead of leading it — inverts BR-033 | ❌ Rejected |
| **No types** | Nothing to build | No autocomplete in a TypeScript-first product | ❌ Rejected |

## Decision Rationale

Hand-authoring inverts the usual direction deliberately: the declaration is the specification, and
the runtime must conform to it. Conformance is enforced with a type-level assertion in awcli's own
build, so a runtime that drifts from the published contract fails the build rather than surprising a
workflow author. Regeneration is triggered whenever the version that produced the file differs from
the running binary (P0-9), which closes the staleness gap.

## Consequences

### Positive
- Workflows are fully typed with zero installation, in a repository of any language.
- The contract can be reviewed, frozen, and authored against in week one (P0-13).
- Types cannot describe something the runtime does not implement.

### Negative
- The declaration and the implementation are two places describing one shape.
- A committed generated file will occasionally show up in diffs after an upgrade.

### Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Declaration and runtime drift silently | High | Low | Compile-time conformance assertion in awcli's build; drift is a build failure |
| Stale declaration after a global upgrade | Med | High | Regenerate when the producing version differs from the running binary |
| Contract additions become breaking changes | Med | Med | Additive-only within a major version; the version range gate (BR-003) makes a major the signal |

## Related

- **Rules:** BR-003, BR-032, BR-033
