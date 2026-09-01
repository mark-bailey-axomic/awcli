# AWCLI-29 — [AWCLI] One copy of the filesystem guards the runtime modules share

**Points:** 2 · **Source:** new — review of PR #15, run 3 (F-029 there: the duplicated fs helpers) · **Status:** Ready

## Problem / Goal

`src/runtime/run-lock.ts` and `src/runtime/workspace.ts` each carry their own copy of the same
five filesystem guards: `lstatOrMissing`, `isErrno`, `errnoOf`, `ignoreCleanupFailure`, and the
"cannot write here" and "nothing through a symlink" guards that use them. The first four are
byte-identical; the last two differ only in the sentence they hand the operator.

They have already drifted once and been re-synchronised by hand, which put two copies back in
agreement without removing the mechanism that separated them. They are drifting again:

- `workspace.ts`'s ancestor guard names an ancestor that exists as an ordinary *file* — a
  repository carrying a tracked file called `.awcli` — and `run-lock.ts`'s does not, so the same
  repository still throws a bare `ENOTDIR` and a stack trace out of the lock path.
- Commit 09214f6 declared the convention that `assert*` throws and `refuse*` produces a refusal,
  and `workspace.ts`'s docblock justifies it as protecting "the one place a maintainer copies
  from". That place is `run-lock.ts`, which still calls its two *throwing* guards
  `refuseSymlinkedAncestors` and `refuseUnwritable`.

The third caller is the one this ticket is for. AWCLI-14, AWCLI-22 and AWCLI-25 all touch the
runtime layout, and each will copy whichever version it happens to open.

## Context

This was raised in run 2 of PR #15 and again in run 3. It was not fixed in either round, and the
reason is worth recording rather than leaving as an omission: `run-lock.ts` belongs to AWCLI-07,
which is merged, and both of the changes above are behaviour changes to it — a new sentence for a
case it currently throws a raw errno on, and a rename that moves three anchors in
`verify-lock-gate.sh`. Making them inside AWCLI-13's pull request would put an unreviewed change
to a shipped module in a ticket that does not own it, which is the ownership discipline the rest of
that review is about. The extraction is right; the place for it is a ticket of its own.

Roughly twelve lines move. Neither gate loses a mutation: each one anchors on a line that still
exists, in a different file.

## Functional

- Move `lstatOrMissing`, `isErrno`, `errnoOf`, `ignoreCleanupFailure` and the two guards that use
  them into one module both `run-lock.ts` and `workspace.ts` import.
- Keep the two operator-facing sentences distinct — the lock's and the working copy's remedies are
  not the same sentence — by parameterising what the guard is protecting, not by keeping two guards.
- Name the moved guards for the channel they use: `assert*` throws, `refuse*` refuses.
- Give the lock path the "an ancestor is an ordinary file" sentence the workspace path has.

## Non-Functional

- No behaviour change on the workspace path: it already has both sentences.

## Constraints

- `verify-lock-gate.sh` and `verify-workspace-gate.sh` both mutate lines that move. Update the
  anchors; never delete a mutation to make one match.

## Acceptance Criteria

- [ ] One definition of each of the five, imported by both modules — asserted by there being no
      second definition to find.
- [ ] A repository carrying a tracked file at `.awcli` is named as such on the lock path, not
      thrown at as a bare `ENOTDIR` — asserted by test, watched failing first.
- [ ] Both mutation gates still pass, with every mutation that named a moved line re-anchored
      rather than removed.
- [ ] All tests pass, format check clean, type check clean.

## Out of Scope

- The layout functions themselves (`runDirectoryAncestors`, `worktreePathAncestors`) — they are
  derived per resource and correctly live in `run-identity.ts`.

## Dependencies

**Blocked by:** None
**Blocks:** None

Neither, deliberately. It touches two shipped modules and no contract, so it is workable whenever
someone picks it up — and the longer it waits the more likely a third caller copies one of the two
versions rather than importing the one.
