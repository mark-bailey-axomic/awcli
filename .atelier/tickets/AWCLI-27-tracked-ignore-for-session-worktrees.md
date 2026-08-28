# AWCLI-27 — [AWCLI] Ignore the nested session worktrees in one tracked place

**Points:** 1 · **Source:** new — review of PR #15 (S-004) · **Status:** Ready

## Problem / Goal

The agent tooling nests session worktrees at `.claude/worktrees/<session>`, a full second copy of
the repository inside the repository. Git ignores them through `.git/info/exclude`, which is
per-clone and untracked — so the exclusion exists on the machine that wrote it and nowhere else,
and every tool that has to skip those copies grows its own hand-written duplicate of the pattern.

There are two duplicates already. `.prettierignore` carries one with a five-line paragraph
explaining why, added after a deliberately malformed fixture found inside a session worktree
turned `npm run check` red for whoever held one while CI stayed green on a fresh checkout.
`vitest.config.ts` carries the second, added by AWCLI-13 for the same reason. The third is
waiting for the next tool that walks the tree.

Moving the pattern into the tracked `.gitignore` fixes it once for every contributor and every
fresh clone, and lets at least one of the two duplicates be deleted rather than maintained.

## Context

The two duplicates are not equivalent, and the difference decides how much this ticket can remove.
Prettier 3 reads `.gitignore` by default, so a tracked entry makes the `.prettierignore` copy
redundant. Vitest does not — its `exclude` is its own list — so `vitest.config.ts` keeps its
entry regardless. This ticket therefore removes one duplicate and prevents future ones; it does
not collapse the vitest exclusion, and a reader should not expect it to.

`.git/info/exclude` was the right instrument when the worktrees were one operator's local habit.
They are now a documented part of how this repository is worked in — the rationale lives in
`~/.claude/docs/worktree-session-isolation.md` and the pattern has already cost one red build —
which makes the exclusion a property of the project rather than of a checkout.

The runtime path this tool writes into a target repository is a separate matter and is AWCLI-22's:
that entry is written into the *operator's* repository by `awcli init`. This ticket is about
awcli's own working copy.

## Requirements

### Functional

- Add the session worktree path to the tracked `.gitignore`, with the rationale a reader needs to
  know why a second copy of the repository lives inside it.
- Remove the `.prettierignore` duplicate, keeping whatever of its rationale is not now stated in
  `.gitignore`.
- Leave `.git/info/exclude` alone — it is not this repository's to rewrite, and an entry there
  that is now redundant is harmless.

### Non-Functional

- A fresh clone skips the session worktrees with no per-machine setup.
- `npm run check` behaves identically whether or not the checkout holds session worktrees.

## Constraints

- The vitest exclusion stays: vitest does not read `.gitignore`, and removing it would restore the
  defect AWCLI-13 fixed.

## Acceptance Criteria

- [ ] `.gitignore` excludes the session worktree path and says why.
- [ ] `.prettierignore` no longer names it, and `prettier --check .` still passes with a session
      worktree present holding a deliberately malformed fixture.
- [ ] A clone with no `.git/info/exclude` entry does not report the session worktrees as untracked.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- The runtime path written into a target repository — AWCLI-22.
- The vitest exclusion of that runtime path — already delivered by AWCLI-13.

## Dependencies

**Blocked by:** None
**Blocks:** None
