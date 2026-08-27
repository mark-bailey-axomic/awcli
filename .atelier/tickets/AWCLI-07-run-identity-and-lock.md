# AWCLI-07 — [AWCLI] Name runs and take a reclaimable exclusive lock

**Points:** 2 · **Source:** WB-5 (part 1 of 2) · **Status:** In Review

## Problem / Goal

Two concurrent runs writing the same shared state would corrupt it. A named run with an
exclusive lock makes that impossible — but a lock that survives a killed process would block the
operator permanently, so it must be reclaimable when its owner is provably gone.

## Context

Single-writer state is the mechanism that makes durable shared state safe (ADR-0005). The lock
records the owning process and its start time, so liveness can be distinguished from a recycled
process ID. Named runs also allow deliberate overlap: two differently named runs are two
different writers and may proceed together.

## Requirements

### Functional

- Derive a run name from an explicit option, falling back to a deterministic default.
- Take an exclusive lock per run name, recording owner process and start time.
- Refuse a second run of the same name while the first is live.
- Allow differently named runs to proceed concurrently.
- Reclaim a lock whose owner is gone, and report that a reclamation happened.
- Register the lock for release on every exit path.

### Non-Functional

- A long-running but live owner must never have its lock reclaimed.
- A recycled process ID must not be mistaken for the original owner.
- Reclamation is reported, never silent.

## Constraints

- Liveness is decided from recorded owner identity, not from a timeout on file age alone.
- The lock is released through the disposal stack, not by ad-hoc cleanup at call sites.

## Acceptance Criteria

- [x] Scenario: *Two runs of the same name cannot overlap*.
- [x] Scenario: *Differently named runs may overlap*.
- [x] Scenario: *A lock left by a killed run is reclaimed automatically*.
- [x] Scenario: *A slow run keeps its lock*.
- [x] A reused process ID belonging to a different process does not read as the original owner.
- [ ] A reclamation is carried on the outcome of every acquisition that made one, on the success
      shape and the refusal shape alike, and every stale lock destroyed is accounted for in the
      message.
- [x] All tests pass, format check clean, type check clean.

## Out of Scope

- The run record and attribution — AWCLI-08 pairs with this but ships separately.
- State contents and validation — AWCLI-09.
- **Printing** the reclamation. This ticket produces the sentence and makes the field required on
  both outcome shapes, so it cannot be dropped in transit, and the acceptance criterion above is
  about that channel rather than about anything reaching a terminal. No command takes a run lock yet
  — `acquireRunLock` has no caller outside its own module and `cli.ts` still says no workflow
  commands exist — so the first ticket to wire a run command owns the printing. Named here because a
  business-rule half that no ticket owns is a half that ships as never-written.
- Collecting inert `lock.stale.<uuid>` leftovers. They are read and judged, and deliberately not
  deleted: one may be another process's set-aside file mid-reclamation. Removing what is provably
  safe to remove is AWCLI-22's clean.

## Dependencies

**Blocked by:** AWCLI-03
**Blocks:** AWCLI-08, AWCLI-09, AWCLI-13, AWCLI-21, AWCLI-22

## Notes

Two notes on the criteria themselves, because both are conventions rather than code.

The reclamation criterion was added by a review round, so it is not ticked here: `tickets/README.md`
reserves the tick for a criterion a reviewer has confirmed, and the author who adds one does not get
to close it. It is implemented — `reclaimed` is required on both outcome shapes and `changeNote`
lists every reclamation — and both halves have mutations in `verify-lock-gate.sh`. The same rule says
a criterion a round *reopens* should be unticked while it is open, and the reclamation path's
criterion stayed ticked through a round that had a blocking finding sitting on it. It should not have.

The last criterion said "lint clean" for every one of the 27 tickets, and there is no linter in this
repository: no eslint, no config, and `npm run check` is `format:check && test && build`. It is
reworded here to what is actually run. Rewording it across the other tickets, or adding a real
linter, belongs to whoever does that as its own change.

Each criterion above was watched failing before it was ticked. `scripts/verify-lock-gate.sh`
(wired into `npm run check:gates`, and so into CI) applies a plausible wrong implementation for each
one — trust the pid alone, reclaim anything older than an hour, refuse every existing lock, one lock
file per repository, unlink whatever is at the path, slugify what the operator typed — and fails if
the suite still passes with any of them applied. A mutation whose anchor has drifted fails the script
rather than being skipped, which has fired for real on this ticket several times, always because a
remediation moved code a mutation was anchored on. How many times is deliberately not written down
here or in the script: review found the two places disagreeing about it, which is the same lesson as
the mutation counts that came out a round earlier.

Two properties came out of building it that the ticket did not name, and both are load-bearing:

- The lock file is linked into place from a staging file, so a lock is never observed
  half-written. That is what makes "unreadable therefore reclaimable" sound rather than a guess;
  without it, a corrupted lock would have to be treated as live and would block the run name for
  ever.
- Reclamation removes only the file it judged stale, verified by the file's own bytes after taking
  custody of it — not by its inode, which is recycled just as a process id is. Nothing is judged
  while the name is free: the file goes back first and is judged on the next attempt.
- A lock sitting *beside* the lock path is read before the name is treated as free. Three different
  things wear that name — a reclamation that could not put a lock back, one still in progress
  elsewhere, and a restore whose cleanup failed, which leaves a second link to the live lock — and
  only the first is a reason to refuse. Telling them apart is what stops a failed reclamation from
  permitting the collision it prevented, without blocking a run name on litter.

`worktrees` is refused as a run name: the layout puts working copies at
`run/worktrees/<run>/<slot>`, a sibling of `run/<run>/`, so that name would put a run's state
directory and the worktree root at one path.

### What review changed

One thing here is worth carrying to the next ticket, and it is not any individual defect: **the
dangerous code on this ticket was never the original mistake — it was the error handling of the
correction.** Every blocking finding after the first round was inside a fix written for an earlier
blocking finding. Three consecutive rounds landed on `removeExactly`, each time on a path that only
opens when something has already gone wrong: a `finally` that deleted the live lock it had
displaced, a read with nothing to catch it, and a re-judgement that spawned `ps` while the run name
sat free on disk.

The round after that found nothing wrong inside the function — and twenty findings around it. A
restructure moves the ground under everything that referred to the old shape, and none of it moves by
itself: the docblock the remediation had just rewritten still described the mechanism it deleted, one
mutation covered two behaviours at once so the weaker wrong implementation was pinned by nothing, a
new branch arrived with neither test nor mutation, the refusal added to close one finding prescribed a
removal that could destroy a live lock, and the exhaustion message went on describing a route that no
longer led there. So the second half of the lesson: **a correction is not finished when the function
is right.** The comments, the messages, the mutations and the neighbouring branches are all part of
it, and every one of them can go on asserting the version that was replaced.

The findings themselves sort into four classes, and the classes are more useful than a log of them
would be — the log is in the PR, and a chronology in a ticket drifts out of date twice before anyone
reads it.

- **Sequential tests could not see any of it.** Both properties above exist *only* to survive
  concurrency, and the first version passed every criterion with neither of them. Regression tests
  now park one acquisition inside the probe with a latch, so an interleaving is chosen rather than
  hoped for; a second suite substitutes individual `fs` calls, because there is no portable way to
  fill a disk or fault a device from a test; and one defect — an unreferenced backoff timer, which
  stopped the acquisition returning at all — was invisible to *every* vitest test, because vitest
  holds the event loop open. Its gate runs a bundled fixture as a plain node process
  (`scripts/verify-acquisition-returns.sh`).
- **Fail-open liveness.** A question that could not be answered read as "the owner is gone": a `ps`
  timeout, an `EAGAIN` from fork, a container image whose `ps` does not take `-o lstart=` and exits
  1 saying so, a lock written on another machine. Every one of those evicted a *live* owner's lock,
  and load-correlated, so it fired exactly when a second run was there to collide with. "Could not
  ask" is now its own answer and refuses on it — and carries the probe's reason, so an operator can
  tell a `ps` that is missing for good from a machine that was briefly too busy.
- **Names and paths.** A run name reaching a path unvalidated (`"../../../etc"` escaped the runtime
  directory, `""` collapsed every run onto one lock file), a committed symlink at `.awcli`,
  `.awcli/run` or the lock itself, an ancestor walk that left the repository for `--repo /repo/`,
  and names that git or a case-insensitive filesystem would have refused later — after the run had
  taken its lock and started work. All refused up front now, and a validated name is branded so an
  unvalidated one cannot reach a path without a deliberate cast.
- **What a message claims.** A refusal is the whole of this unit's interface, so a message that
  overstates is a defect and was treated as one: "nothing has been changed" printed after deleting a
  file, a reclamation reported against the wrong file, an exhaustion asserting a cause nobody had
  established, a lock file's escape sequences and bidi controls reaching the terminal, a refusal
  that threw while formatting itself, and a refusal that never said which file to remove.

  The same standard applies to comments claiming guarantees the code does not give, and applying it
  is a running job rather than a finished one — this section said it in the past tense for a round,
  while several stood and two more had just been written. The most instructive of them is the
  docblock on `removeExactly`: the paragraph describing the mechanism a remediation *deleted* was
  left in place directly above the paragraph explaining why it had to go. A comment is only ever
  correct as of the code beneath it.

The tooling took as much fixing as the code, for the same reason: a gate that is not itself
trustworthy is worse than no gate. The harness now works in a private copy of the working tree —
mutating tracked files in the developer's own checkout corrupted a reviewer's reading of this branch
more than once, and restoring afterwards does not help, because the hazard is the window — and requires
*each* substitution to match exactly once, where adding the counts up let a mutation half-apply
while the criterion its other half tested silently stopped being tested. Its self-test covers every
way the old checks could be fooled. Two mutations turned out not to be gates at all; one of them
asserted nothing on Linux, where `identify` answers out-of-range ids from `/proc` rather than from
`ps`, so that rule moved into `isPossiblePid` where it can be checked without an operating system.
And the check at the centre of all of it was itself too weak, in four separate ways, all of the same
shape — **a gate that reports on something it did not actually do**:

- `expect_red` treated any non-zero exit as proof that a criterion is checked, while vitest exits
  non-zero for a mutation it cannot parse, printing `Tests  no tests` with not one assertion
  evaluated. It now requires the summary to name a failing test.
- A red produced by a *timeout* was accepted the same way, and a timeout is as likely to be a slow
  machine as a broken criterion. One mutation here does want a hang — removing the acquisition
  loop's bound — and it now says so by name, so every other mutation can refuse one.
- Perl interpolates a replacement as a double-quoted string, so `${path}` in one is a symbolic
  dereference that silently becomes empty. Two mutations spent a round claiming to insert a template
  literal and inserting a broken one; both still turned the suite red, for the wrong reason. An
  unescaped `$` in a replacement is now refused.
- `perl -0i` on a subject that does not exist warns and exits 0, mutating nothing — so the suite
  passes *unbroken* and the gate reports the criterion as unchecked. Found by making the mistake that
  reaches it: an apostrophe inside a double-quoted criterion string splits the arguments, and the
  next word arrives as the subject. A missing subject is now refused.

Every one of those was found while fixing something else, and every one had been reporting `ok`. The
harness's self-test covers all four, and each was watched failing with the check disabled.

Three findings were argued rather than fixed, and all three stand.

An unreadable lock is reclaimed without a host check: nothing left in a truncated file distinguishes
a sync client truncating a *live* run's lock from an interrupted write, refusing would turn any
garbage at that path into a manual intervention — the opposite of BR-035 — and reclaiming it is an
acceptance criterion.

`check:gates` pays one cold vitest start per mutation, and the whole of it is minutes in its own CI
job. The suggested fix — scope each mutation to the one spec that covers it, and run the isolated
gate scripts concurrently — would work, and it is a change to every mutation whose narrowing has to
be re-verified one at a time, which is a job with its own risk of quietly narrowing a mutation onto
a suite that no longer catches it. Left as it is, deliberately, in a job that is not on the fast
path.

`PS_TIMEOUT_MS` bounds one `ps` and nothing bounds an acquisition's total probe time, so a machine
whose process table is wedged can cost several timeouts in series before a refusal. An aggregate
deadline is the right answer and it is a behaviour change — the refusal it produces is a *new* way to
refuse a legitimate run — which wants its own criterion rather than arriving inside a remediation.

One thing the ticket did not ask for was added, because the alternative was worse: a lock a failed
reclamation leaves displaced is now *read* before a later run takes the name. It used to be written
to disk under a `.stale.<uuid>` name, its path named in the failure, and then never looked at again —
so the invocation after the failure found a free lock path and took the name alongside a run that may
still have been working under the displaced file. A failure that prevents one collision must not
permit the next one. Telling that file apart from the two other things wearing the same name — a
reclamation still in progress elsewhere, and a restore whose cleanup failed, which leaves a second
link to the *live* lock — is most of what that check is.
