# ADR-0007: WSL2 Is The Windows Path; Native win32 Is Refused At Startup

**Date:** 2026-08-24
**Status:** Accepted
**Context:** [TDD](../../.atelier/design/agentic-workflow-cli-tdd.md), PRD P2-2, BR-001

## Decision

awcli supports macOS, Linux, and WSL2. It refuses to run on native win32 at startup, naming WSL2 as
the supported Windows path. No win32-native code paths are written, but host-to-container path
mapping and process teardown are each isolated behind a single module so the option is not foreclosed.

## Context

The author uses both a Mac and a Windows machine; every colleague who might adopt awcli is on macOS
or Linux. So Windows is a real target machine — but "Windows the machine" and "the win32 Node
platform" are different things, and the distinction decides the cost.

The container path needs Docker. On Windows, Docker Desktop's default backend *is* WSL2 — so an
operator who wants containers already has a Linux environment. Running awcli inside it is not a
workaround; it is the same Linux path that runs on the Mac.

Sandcastle, the reference implementation, does support win32, and the shape of that support is the
evidence for what it costs: a dedicated ADR for git-worktree mounts on Windows, three separate
`*windowsMounts*` test files, `WorktreeManager.windowsPath` and `SessionStore.windowsPath` test
files, and a UID-alignment build-arg that no-ops because `process.getuid` does not exist there.

What specifically breaks natively:

- **Bind-mount path translation** — a Windows path must be rewritten for the container, and Docker
  Desktop versus WSL2 backends differ.
- **No file-ownership alignment** — files an agent creates in a bind-mounted container get wrong
  ownership, with no UID to align to.
- **Process teardown** — no POSIX signals, so stopping an agent's process tree needs different
  machinery. This lands directly on BR-021 (interrupt always releases the lock and preserves work)
  and BR-022 (finished-but-lingering processes).
- **Path handling throughout** worktrees, state, and logs.

## Alternatives Considered

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **WSL2 only; refuse win32 with a pointer** | Zero cost; identical code path on every supported platform; no Windows user is actually excluded, since Docker on Windows already means WSL2 | "Install WSL2 first" is friction for a Windows-heavy team; clones must live in the WSL2 filesystem for acceptable git and node performance | ✅ **Chosen** |
| Native win32 as an explicit later goal | Keeps a real option open for a Windows-heavy team at no cost today | A deferred promise that may never be redeemed, and the seams alone do not make it work | Future consideration — the isolated path-mapping and teardown modules are where it would land |
| Native win32 in v1 | Works with no Linux environment at all | Path translation, teardown machinery, no ownership alignment, and a Windows CI matrix — added to a v1 that is already mostly plumbing | ❌ Rejected — the only Windows user already has WSL2 |

## Decision Rationale

The cost is asymmetric. Supporting win32 means four distinct subsystems behave differently on one
platform, with a CI matrix to prove it — and sandcastle's tree shows that tax is not theoretical.
Not supporting it costs one startup check and a documentation line, and excludes nobody: the single
Windows operator runs Docker, therefore runs WSL2, therefore runs the Linux path.

Refusal must point somewhere. A bare "unsupported platform" would be a dead end; naming WSL2 and the
clone-location rule turns it into an instruction.

## Consequences

### Positive
- One runtime shape across every supported platform: no per-platform mount, path, ownership, or
  signal handling.
- BR-021 and BR-022 have one implementation, not two.
- No Windows CI matrix.

### Negative
- A Windows operator must set up WSL2 and keep clones inside its filesystem, not under `/mnt/c`,
  where git and node performance across the filesystem boundary is poor.
- Editing workflows on Windows means working through a remote-filesystem editor session.
- The global workflow library in WSL2 is a different directory from the Mac's, so it is synced by the
  operator (a git remote) rather than by awcli — which is why the library must stay clean enough to
  commit (BR-029).

### Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Operator runs awcli in WSL2 against a `/mnt/c` clone and finds it unusably slow | Med | Med | The refusal message and docs state the clone-location rule; `doctor` (P1-6) can flag a cross-boundary path |
| A colleague on Windows arrives later and will not use WSL2 | Low | Low | Reopen this ADR; the isolated path-mapping and teardown modules are the landing zone |
| Path separators leak into stored records, making state non-portable between machines | Med | Low | Path joins never hand-built; stored paths are repo-relative, so a record written on one machine reads on the other |

## Implementation Notes

The platform gate belongs in the gate chain (WB-4), first, before the repository check — it is the
cheapest and most certain refusal. Free discipline adopted regardless of this decision: never
hand-build a path with a separator, keep host-to-container path mapping in one module, and keep
process teardown in one module.

## Related

- **TDD:** [agentic-workflow-cli-tdd.md](../../.atelier/design/agentic-workflow-cli-tdd.md)
- **Rules:** BR-001, BR-021, BR-022, BR-029
- **PRD:** P2-2 (native win32 — not planned)
