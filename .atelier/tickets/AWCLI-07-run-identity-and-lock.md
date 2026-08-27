# AWCLI-07 — [AWCLI] Name runs and take a reclaimable exclusive lock

**Points:** 2 · **Source:** WB-5 (part 1 of 2) · **Status:** Done

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
- [x] All tests pass, lint clean, type check clean.

## Out of Scope

- The run record and attribution — AWCLI-08 pairs with this but ships separately.
- State contents and validation — AWCLI-09.

## Dependencies

**Blocked by:** AWCLI-03
**Blocks:** AWCLI-08, AWCLI-09, AWCLI-13, AWCLI-21, AWCLI-22

## Notes

Each criterion above was watched failing before it was ticked. `scripts/verify-lock-gate.sh`
(wired into `npm run check:gates`, and so into CI) applies twenty plausible wrong implementations —
trust the pid alone, reclaim anything older than an hour, refuse every existing lock, one lock file
per repository, unlink whatever is at the path, slugify what the operator typed — and fails if the
suite still passes with any of them applied. It has fired for real twice on this ticket, both times
because a refactor moved an anchor.

Two properties came out of building it that the ticket did not name, and both are load-bearing:

- The lock file is linked into place from a staging file, so a lock is never observed
  half-written. That is what makes "unreadable therefore reclaimable" sound rather than a guess;
  without it, a corrupted lock would have to be treated as live and would block the run name for
  ever.
- Reclamation removes only the file it judged stale, verified by the file's own bytes after taking
  custody of it — not by its inode, which is recycled just as a process id is.

`worktrees` is refused as a run name: the layout puts working copies at
`run/worktrees/<run>/<slot>`, a sibling of `run/<run>/`, so that name would put a run's state
directory and the worktree root at one path.

### What review changed

The first version of this unit passed all six criteria and shipped four defects, every one of them
in a place the suite could not look. Recorded here because the pattern generalises: the tests were
all sequential, and both properties above exist *only* to survive concurrency.

- **Reclamation was not mutually exclusive.** It renamed whatever was at the lock path aside on the
  strength of a judgement made before the rename, with a `ps` spawn in between. Two runs meeting
  the same stale lock after a reboot — the ordinary case reclamation exists for — could both come
  away holding the name. Now: take custody, verify the inode, re-judge and restore if it was not
  the file judged. The regression test parks one acquisition inside the probe with a latch, so the
  interleaving is deterministic rather than hoped for.

  The first fix for this compared inode numbers, and the Linux CI leg caught it: on ext4,
  reclaiming the stale lock frees its inode and the next staging file is handed the same number, so
  the winner's *live* lock compared equal to the dead one and was deleted. Identity is the file's
  bytes now. Worth recording as its own lesson — the fix repeated the ticket's own mistake one layer
  down, and macOS could not reproduce it.
- **The acquisition loop was unbounded.** A `continue` jumped the attempt check, and a dangling
  symlink at the lock path pins both branches for ever (`link` answers EEXIST, `readFile` answers
  ENOENT), so awcli spun at startup. The bound now covers every path, and a symlink at the lock
  path or its directory is refused outright.
- **An unanswerable probe read as "owner gone".** A `ps` timeout, an `EAGAIN` from fork, or a
  container image without `ps` all evicted a live owner's lock — load-correlated, so it fired
  exactly when a second run was present to collide with. The probe now answers three ways and
  "could not ask" refuses. So does a lock written on another machine, whose pid this machine's
  process table cannot speak to; that is what the recorded `host` field is for, and the first
  version wrote it without reading it.
- **`ps -o lstart=` is locale-formatted.** Under `fr_FR.UTF-8` it prints `mer. 26 août ...`, which
  `Date.parse` reads as NaN, so on a French-locale machine no run could ever take a lock. `LC_ALL`
  is pinned, and a test asks under a locale that would otherwise break it.

A third review round (Copilot) found three more, all in the same reclamation area:

- **Symlink refusal covered only the run directory.** `mkdir` with `recursive` follows an existing
  symlink at any level, so a repository carrying a committed symlink at `.awcli` or `.awcli/run`
  had its run directory and lock created outside the repository — and the check saw a real
  directory at the level it inspected and passed. Reproduced before fixing; every ancestor from the
  repository root down is now checked, before the mkdir and again after it.
- **The re-judge inside a reclamation was looser than the acquisition path, in both directions at
  once.** A lock from another host counted as *stale* there, so a reclamation that took it aside
  deleted it — while the acquisition path refuses to judge another machine's pid at all. And a
  recycled process id counted as *live*, so a genuinely abandoned lock was put back and the attempt
  spun instead of reclaiming it. Both now go through the same judgement.
- **`let stats;` was an implicit `any`**, which would have hidden a mistake in the `Stats` API
  rather than failing the typecheck.

Fixing the second of those exposed a reporting bug: the reclamation reused the caller's verdict,
which on the mismatch path describes a file still on disk rather than the one removed. The removal
now returns the verdict for what it actually took away.

A fourth round found two more, both latent rather than reachable today:

- **The staging write was outside its own cleanup.** `wx` creates the file and then writes to it, so
  a failure part-way through — ENOSPC, EIO — left an empty staging file in the run's directory with
  nothing to remove it. Never linked, never read, but one more thing to explain to whoever is
  debugging a lock. EEXIST is deliberately still not cleaned: that file is not ours.
- **The gate harness backed subjects up by basename.** Two subjects sharing one — `src/a/index.ts`
  and `src/b/index.ts` — would have shared a backup, so restore would write one subject's contents
  over the other. No gate has same-basename subjects today, which is why it was worth fixing: it is
  a trap set for whoever adds the second one, in the file whose whole job is to be trustworthy
  about restoring a tree it deliberately broke. `scripts/verify-mutation-gate.sh` now self-tests
  backup and restore against same-basename and spaced paths, and I watched it fail against the
  basename version.

A fifth round found two more in the code the fourth round had just added:

- **The ancestor walk stopped by string equality against the repository path.** `--repo /repo/` — a
  trailing separator, which shell completion supplies — never equals `/repo`, so the walk carried on
  past the repository and inspected paths above it, which its own comment said must never happen.
  The list is now derived forwards from the layout by `runDirectoryAncestors`, so there is no
  stopping condition to get wrong. The regression test reaches the repository through a symlinked
  parent, so an implementation that walks out refuses a run it has no business refusing.
- **The terminal "could not take the lock after N attempts" claimed nothing had changed** while a
  reclamation may already have deleted a file — the same defect fixed in the two refusal messages a
  round earlier, and missed here.

That second one cannot be reached by this suite: it needs three rounds of genuine contention. Rather
than tick a criterion with no gate behind it, the claim now lives in exactly one function and a test
asserts that structurally — a fourth message with its own hardcoded copy fails it. The distinction
is deliberate: the check is over the shape of the code, not over the behaviour, and it says so.

Also from review: the validated run name is branded, so an unvalidated string can no longer reach a
path (`"../../../etc"` escaped, `""` collapsed every run onto one lock); names ending in `.lock` and
names differing only by case are refused, both of which git or a case-insensitive filesystem would
otherwise refuse later, after the run had started work; the staging file is keyed by UUID with
`wx`, so two acquisitions in one millisecond cannot truncate an already-linked live lock through a
shared inode; a refusal that reclaimed on the way reports it and no longer claims nothing changed;
and the gate harness is shared with the disposal gate rather than copied.

A sixth round — a second full review — found eight more, and the two blockers were again in the
remediation rather than in the original code. That pattern is the most useful thing this ticket has
produced: on every round, the dangerous code has been the error handling of a correction.

- **The backoff timer was unreferenced, so acquisition never returned.** `timer.unref()`, copied
  from `disposal.ts` where it is correct — those are timeout races that must not hold a process
  open. Here the acquisition is *waiting on* the timer, and with nothing else pending node concludes
  the event loop is empty and exits. Reproduced from a child process: against a real stale lock,
  `acquireRunLock` reclaimed it and then never returned at all — no lock, no refusal, no error, exit
  13 on an unsettled await. That is the ordinary BR-035 reclaim path, and it hit every other route
  round the loop too.

  The suite structurally could not see it, because vitest holds the event loop open. So the gate for
  it is not a vitest mutation: `scripts/verify-acquisition-returns.sh` bundles a fixture with the
  project's own bundler, runs it as a plain node process, and requires the answer — then puts the
  `unref` back and requires the answer to be missing. Watched fail both ways.
- **`removeExactly` deleted the live lock it could not put back.** The `unlink` of the set-aside
  file was in a `finally`, which runs on the throw paths too — so a restore that failed for any
  reason ended with a running owner's lock *deleted* rather than merely displaced, the path free,
  and the next run taking the name alongside it. The BR-010 double-writer the function exists to
  prevent, reached through the error handling of the fix for it. The unlink is now on the success
  path only; both throws name the set-aside path so an operator can find the file.
- **A reclamation on the final attempt was thrown away.** The loop fell straight out of its last
  round: the stale lock was deleted, no lock was taken, and the operator was told the name was
  "being taken and released repeatedly by other processes" while nothing held it. One further
  create, bounded and with no new judgement, is all that state needed.
- **Tidying up could turn a taken lock into a failure.** After the lock is linked into place the
  staging file is removed; a failure there (EIO, a read-only remount) threw out of a *successful*
  acquisition, leaving a lock nothing would ever release and a run name unusable until someone
  deleted the file by hand. Cleanup is now best-effort, and deliberately so — a leftover
  `.staging.<uuid>` is inert by comparison, and on the failure paths an exception from a `finally`
  would have replaced the real error anyway.
- **`ps` exiting 1 was trusted on its own.** busybox's `ps` — the one in a great many container
  images — does not take `-o lstart=` and exits 1 saying so, and reading that status alone as "no
  such process" would evict a *live* owner's lock on every ask in any image that ships it. An exit
  of 1 now means "gone" only when nothing was said on stderr. That change surfaced a second thing:
  an out-of-range process id makes `ps` complain too, so ids above `PID_CEILING` are now answered
  without asking.
- **The locale test could not fail.** It went through `identify`, which on Linux reads `/proc` and
  never reaches `ps` — so on the platform most of CI runs on it asserted nothing — and it passed on
  any machine whose C library has never been given fr_FR, because `ps` then falls back to C. It now
  calls `psIdentify` directly, *establishes* that the locale changes the output before asserting
  anything, and skips explicitly when it cannot. A mocked adapter suite carries the always-available
  gate: the pin is asserted on the environment handed to the spawn, which fails everywhere.
- **The mutation harness added its substitution counts up.** One `/g`, or one pattern matching
  twice, satisfied the total while a sibling matched nothing — so a mutation could half-apply, the
  suite could go red for the half that landed, and the criterion the other half tested would
  silently stop being tested. The same defect the check was added to close, one level up. Each
  substitution must now match exactly once, and the self-test covers all four ways the old check
  could be fooled.
- **The gates mutated the shared checkout.** They spend most of their run with tracked sources
  deliberately broken *in the developer's own working tree*, where an editor, a language server or
  another session sees a mutation with no way to know it is not theirs — it corrupted the reviewer's
  own reading of this branch three times. Restoring afterwards does not help; the hazard is the
  window. Every gate now works in a private copy of the working tree with `node_modules` symlinked,
  and the self-test asserts that breaking a tracked file leaves the checkout untouched.

Two smaller ones from the same round, both about what a refusal prints: a lock file's `host` went to
the terminal unfiltered, so a repository could repaint an operator's screen and show them a refusal
awcli never wrote; and `acquiredAt` came off disk into `new Date(...).toISOString()`, which throws
out of range — a refusal that throws while formatting itself reaches the operator as a stack trace
instead of as the reason their run will not start.

Four comments were also corrected rather than reworded: the reclaim window described as "two
syscalls rather than a subprocess spawn" (the re-judgement added later spawns `ps` inside it), the
symlink rationale claiming `link`/`rename`/`unlink` follow symlinks (they do not — only `readFile`
does, which is a different and narrower hazard), and two claims that an unreadable lock cannot have
come from a live run. That last one is a statement about awcli's writer, not about the file: a sync
client mid-transfer can truncate a live run's lock, nothing left in the file distinguishes that from
an interrupted write, and refusing instead would turn any garbage at the path into a manual
intervention — the opposite of BR-035. The behaviour is unchanged and the limit is now written down.

The gate is 37 lock mutations plus 8 disposal mutations plus the out-of-process acquisition check.
That is one vitest start per mutation and about two minutes in its own CI job; the cost is inherent
to mutation testing and is not something this ticket found a way around.
