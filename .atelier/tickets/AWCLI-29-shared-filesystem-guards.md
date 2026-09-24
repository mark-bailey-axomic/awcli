# AWCLI-29 — [AWCLI] One copy of the filesystem guards the runtime modules share

**Points:** 3 · **Source:** new — review of PR #15, run 3 (F-029 there: the duplicated fs helpers); widened in run 6 to carry the refusal-message extraction · **Status:** Ready

## Problem / Goal

`src/runtime/run-lock.ts` and `src/runtime/workspace.ts` each carry their own copy of the same
six filesystem guards: `lstatOrMissing`, `isErrno`, `errnoOf`, `ignoreCleanupFailure`, and the
"cannot write here" and "nothing through a symlink" guards that use them. The first four are
byte-identical; the last two differ only in the sentence they hand the operator. Six rather than the
five this said, counted off the definitions rather than the sentence: `run-lock.ts` defines
`refuseSymlinkedAncestors`, `lstatOrMissing`, `refuseUnwritable`, `isErrno`, `errnoOf` and
`ignoreCleanupFailure`, and `workspace.ts` defines `assertNoSymlinkedAncestors`, `lstatOrMissing`,
`faultOnUnwritable`, `isErrno`, `ignoreCleanupFailure` and `errnoOf`. Run 5 called it four and run 6
called it five, each time by counting the list and not the enumeration in the same sentence.

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
runtime layout, and each will copy whichever version it happens to open. No *Blocks* edge is
recorded against them even so, and that is a decision rather than an oversight: the edges in this
file are what `verify-spec-invariants.sh` computes the wave diagram from, so a scheduling preference
expressed as a dependency would reshape the graph and claim that none of those three can start until
this lands — which is false, and which is a worse statement than the one this paragraph makes. What
is true is narrower: whichever of the three lands first should land after this, and if it does not,
it copies a guard whose weaker copy is a symlink-escape.

## Context

This was raised in run 2 of PR #15 and again in run 3. It was not fixed in either round, and the
reason is worth recording rather than leaving as an omission: `run-lock.ts` belongs to AWCLI-07,
which is merged, and both of the changes above are behaviour changes to it — a new sentence for a
case it currently throws a raw errno on, and a rename that moves three anchors in
`verify-lock-gate.sh`. Making them inside AWCLI-13's pull request would put an unreviewed change
to a shipped module in a ticket that does not own it, which is the ownership discipline the rest of
that review is about. The extraction is right; the place for it is a ticket of its own.

About forty lines of code move, not the twelve this said. Measured over the six definitions,
bodies only and docblocks excluded: 40 code lines in `workspace.ts` and 39 in `run-lock.ts`, of
which the two ancestor guards are 10 and 14 on their own. Neither gate loses a mutation: each one
anchors on a line that still exists, in a different file.

## Requirements

### Functional

- Move `lstatOrMissing`, `isErrno`, `errnoOf`, `ignoreCleanupFailure` and the two guards that use
  them into one module both `run-lock.ts` and `workspace.ts` import.
- Keep the two operator-facing sentences distinct — the lock's and the working copy's remedies are
  not the same sentence — by parameterising what the guard is protecting, not by keeping two guards.
- Name the moved guards for the channel they use: `assert*` throws, `refuse*` refuses.
- Give the lock path the "an ancestor is an ordinary file" sentence the workspace path has.
- Give the lock path the level-by-level layout maker too, which is the divergence with teeth rather
  than a wording one. `run-lock.ts` still creates its directories with `mkdir(dirname(path),
  {recursive: true})` between two ancestor checks; `workspace.ts` replaced exactly that shape with
  `makeLayout` because a recursive `mkdir` *follows* an existing symlink at any level, so awcli had
  already written outside the repository by the time the second check refused. Checked-then-used
  either way, but one of the two creates nothing through the link. The lock path is reachable by the
  same actor for the same reason, so it gets the same maker — or, if that is declined, Out of Scope
  says so and why, because a known divergence left unnamed is one that gets rediscovered.

- Move `workspace.ts`'s refusal-message layer out with them, or say here why not. Re-measured at run
  7, on the commit that carries this sentence: the file is **2470 lines — 1597 comment, 796 code, 77
  blank** — and the message layer — `shellPath`, `unshowablePathNote`, the two limits,
  `WorktreeRegistration`/`worktreeRegistration`, `canonicalPath`, `Occupancy`, `TargetClaim`,
  `occupiedRefusal`, `BranchCollision`/`branchCollision`, `collisionMessage`, `describe` — is **600
  of those lines and 169 of the code**, each definition counted with the docblock above it.

  The figure it replaces was wrong twice over and is worth recording rather than quietly
  overwritten, because it is the number an implementer sizes this extraction by. It read "1637
  lines, of which 957 were comment and 613 code": 957 + 613 is 1570, so the sentence's two halves
  described different files, and no commit in history matches 1637 either — the parent of the commit
  that introduced the number was 1570, and that commit itself grew the file well past it. Run 6
  raised it and it was not fixed. The three figures now sum, so the same class of error cannot recur
  silently; they are a snapshot of one commit and the file only grows, so treat them as a floor. It
  is the seam with the
  most prose per line of code, it is where the last four review rounds found the most defects, and it
  needs nothing from the provisioning path but a `GitRunner` and four strings. The reason it belongs
  *here* rather than in a ticket of its own is the cost of the move: both extractions re-anchor
  `verify-workspace-gate.sh`, and doing them in one ticket re-anchors it once. The git port is
  already properly separated — nothing in `workspace.ts` knows how git is spawned, bounded or
  classified — so this is the last seam in the file worth moving.

### Non-Functional

- No behaviour change on the workspace path: it already has both sentences.

## Constraints

- `verify-lock-gate.sh` and `verify-workspace-gate.sh` both mutate lines that move. Update the
  anchors; never delete a mutation to make one match.

## Acceptance Criteria

- [ ] One definition of each of the six, imported by both modules — asserted by there being no
      second definition to find.
- [ ] A repository carrying a tracked file at `.awcli` is named as such on the lock path, not
      thrown at as a bare `ENOTDIR` — asserted by test, watched failing first.
- [ ] A symlink planted at any level of the lock path's layout creates nothing through it — asserted
      by test on the lock path the way `workspace-faults.test.ts` asserts it on the worktree path.
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
