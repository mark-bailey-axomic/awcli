# ADR-0006: No Published Base Image — The Generated Dockerfile Is Self-Contained

**Date:** 2026-08-24
**Status:** Accepted
**Context:** [TDD](../../.atelier/design/agentic-workflow-cli-tdd.md)

## Decision

awcli publishes no container image. The generated `.awcli/Dockerfile` starts from a public base and
installs git and the agent CLI itself; the operator extends it with their toolchain.

## Context

The container path needs an image containing the agent CLI and the repository's toolchain. The
original design published `awcli/base:<version>` and had generated Dockerfiles pin it — which made
the image a second released artifact that had to move in lockstep with the binary, and introduced a
skew failure whenever a repository's pinned base was older than the running awcli.

The audience is personal-first (one author, two machines, colleagues on macOS/Linux only if it proves
useful), so a registry, multi-architecture build pipeline, and supply-chain surface are real ongoing
costs against a benefit measured in first-build seconds.

## Alternatives Considered

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **Self-contained generated Dockerfile** | No registry, no release pipeline, no supply-chain surface; the two-artifacts-one-version risk disappears | Slower first build per distinct base image; agent version pinned by cache rather than intent | ✅ **Chosen** |
| Publish per-release, pinned | Fast, consistent, tested environment on a fresh machine | A release pipeline, registry auth, and a second versioned artifact in lockstep | Future consideration — revisit if colleagues adopt it |
| Publish a floating major tag | Least release ceremony of the published options | Builds not reproducible over time; a base change alters behaviour in untouched repositories | ❌ Rejected |

## Decision Rationale

Docker's layer cache is per-daemon, so repositories sharing an identical prelude already share the
install — the cost is per distinct base image per machine, not per repository. What remains is worth
naming honestly: repositories whose toolchain needs a different base cannot share the agent layer at
all, and an install instruction with stable text keeps serving a cached layer long after upstream has
moved.

## Consequences

### Positive
- One fewer released artifact and no version-coupling rule to maintain.
- No registry credentials or image supply chain in the project at all.
- The default (no container) path is unaffected either way.

### Negative
- A repository on an unusual base pays its own agent-CLI install.
- The installed agent version is whatever the cached layer holds, invisibly.

### Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| A stale cached agent version runs for months unnoticed | Med | Med | Agent version stamped in every run record (BR-025); P1-5 introduces a local shared base with a pinned agent and an explicit rebuild |
| Divergent images across repositories | Low | Med | P1-5's local shared base normalises the parent when it becomes annoying |

## Related

- **Rules:** BR-004, BR-016, BR-025
