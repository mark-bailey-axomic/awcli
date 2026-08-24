# ADR-0004: Git And Plain Text Are The Source Of Truth; Structured Agent Output Is Enrichment

**Date:** 2026-08-24
**Status:** Accepted
**Context:** [TDD](../../.atelier/design/agentic-workflow-cli-tdd.md)

## Decision

Everything awcli depends on comes from git or from scanning plain text: commits from the repository,
tagged results and completion signals from text, liveness from any output at all. An agent CLI's
structured event stream is parsed opportunistically for usage and tool visibility only, and every
field degrades to unknown rather than failing a run.

## Context

Agents run as subprocesses (grill Q2), so their output is the primary channel. Agent CLI output
formats are private, differ per tool, and change without notice — the single largest technical risk
identified in the PRD. Sandcastle depends on that stream and defends it with recorded fixtures.

## Alternatives Considered

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **Git + text truth, stream as enrichment** | Nothing load-bearing can break on an agent CLI release; works with bare non-structured output; commits are verifiable rather than reported | Loses cheap session resume, so retry costs a narrow re-ask; usage may be unavailable | ✅ **Chosen** |
| **Full structured parse defended by fixtures** | Keeps session ids, usage, and tool events first-class | Fixtures need refreshing on every agent release, and a format change still breaks the window between release and fix | ❌ Rejected |
| **Pin supported agent CLI versions** | Failures become explicit | Agent CLIs update constantly; either chase them or block your own upgrades | ❌ Rejected |

## Decision Rationale

The realisation that made this cheap: almost nothing genuinely requires structured events. Commits
are in the repository. A tagged block is text. Liveness is any byte. That leaves usage, tool
visibility, and session ids — the first two are conveniences and the third is only needed for retry,
which becomes a narrow re-ask instead (BR-020). Because the agent's work is already committed, a
malformed result costs a decision rather than the work.

## Consequences

### Positive
- The top technical risk is removed rather than defended against.
- awcli works with any agent CLI that can be run non-interactively and print text.
- Retry has no coupling to any agent's private session storage.

### Negative
- Retry re-reads context the agent no longer holds, costing tokens.
- Spend reporting can be unavailable, which weakens the spend threshold (mitigated by a wall-clock
  limit that cannot degrade, and by saying so at startup).

### Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Silent loss of enrichment fields | Med | Med | BR-026: one loud warning, fields marked unknown, run never failed for it |
| Tagged-output convention breaks on an agent's formatting | Med | Low | BR-007 startup check; BR-020 bounded re-ask; agent version stamped for attribution (BR-025) |

## Related

- **Rules:** BR-007, BR-020, BR-022, BR-025, BR-026, BR-027
