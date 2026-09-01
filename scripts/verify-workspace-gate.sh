#!/usr/bin/env bash
# Prove the workspace tests are gates. Every criterion on AWCLI-13 is a claim about a decision that
# is easy to get wrong in a way a happy-path test cannot see: a default that quietly uses the live
# checkout, a consent check that accepts anything truthy, a slot dropped from a path so three
# parallel agents share one working copy, a branch name with a timestamp in it. Each of those
# provisions *something*, and a test asserting only that it got a directory would pass for all of
# them.
#
# AWCLI-00 shipped a ticked criterion whose check was structurally incapable of failing, and it cost
# a review round trip. This script is the answer to that for this unit: every mutation below is a
# plausible wrong implementation — the one a reviewer would suggest, or the one you get from writing
# the obvious version — and the suite has to go red for each.
#
# The headings group by what the defect *is*, not by when it was found.
#
# A mutation whose anchor no longer matches fails the script rather than being skipped. A refactor
# that moves this code should therefore break here loudly: a silently skipped mutation is exactly
# the hole this exists to close. Update the mutation to match the current code; never delete it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Real git in real temp repositories, which is slower than the filesystem work the other gates
# mutate: `git worktree add` three times over in one test, on a machine already running a vitest per
# mutation. The default 5s is a cold-transform margin for pure-computation suites and produces
# timeout reds here that say nothing about the criterion. Set before the harness is sourced, which
# is where the default is applied.
export MG_TEST_TIMEOUT_MS="${MG_TEST_TIMEOUT_MS:-30000}"

# shellcheck source=scripts/lib/mutation-gate.sh
source "$REPO_ROOT/scripts/lib/mutation-gate.sh"

# The workspace suite is eight files rather than one, and that is what makes this gate affordable:
# vitest parallelises across files and not within one, so a single 1800-line suite meant every
# mutation below paid 24 seconds serially — a 20-minute gate, against which two otherwise-wanted
# mutations were already being declined on cost. Named in full rather than by glob so that a new
# file has to be added here deliberately: a suite this gate does not run is a mutation it cannot see.
# Ten suites are listed: the eight workspace files, plus run-identity and git-process, which this gate
# also mutates and so has to run.
mutation_gate_init \
  "test/runtime/workspace-scenarios.test.ts test/runtime/workspace-slots.test.ts test/runtime/workspace-occupied.test.ts test/runtime/workspace-branches.test.ts test/runtime/workspace-preflight.test.ts test/runtime/workspace-faults.test.ts test/runtime/workspace-inherit.test.ts test/runtime/workspace-fs-faults.test.ts test/runtime/run-identity.test.ts test/runtime/git-process.test.ts" \
  src/runtime/workspace.ts src/runtime/run-identity.ts src/runtime/git-process.ts \
  src/contract/awcli.d.ts

# ── Scenario: The default protects my checkout ───────────────────────────────────────────────
# The dispatch goes to the live checkout whichever axis was chosen — the condition dropped rather
# than inverted, which is the same end state either way. Every worktree assertion in the suite has a
# directory and a branch to look at — it is just the operator's own.
expect_red "The default protects my checkout" src/runtime/workspace.ts \
  's/      return choice\.workspace === "liveTree"/      return true/'

# The resolver defaults to the live checkout, so nothing has to be passed to get it. The whole
# design rests on the safe choice being the one you reach by asking for nothing.
expect_red "asking for nothing gives a worktree" src/runtime/workspace.ts \
  's/  return request\.liveCheckout === true/  return true/'

# The handle reports the repository rather than the worktree it just made, so `ctx.fs` and
# `ctx.exec` would operate in the operator's checkout while the run reports a worktree. The worktree
# is still created — so a test that only looks at what exists on disk passes.
expect_red "the handle reports the working copy's own directory" src/runtime/workspace.ts \
  's/  return handle\(git, target, branch, slot, "worktree"\);/  return handle(git, repositoryPath, branch, slot, "worktree");/'

# ── Scenario: Working on the live checkout requires asking for it ────────────────────────────
# The consent check is gone: anyone naming the axis gets the operator's checkout. This is the state
# the code is in before BR-014 is thought about at all.
expect_red "the live checkout requires the operator's consent" src/runtime/workspace.ts \
  's/      if \(choice\.workspace === "liveTree" && choice\.consent !== OPERATOR_CONSENT\) \{/      if (false) {/'

# Consent checked by truthiness rather than by identity — which is what a `boolean` or a
# structurally-typed marker degrades to. `{}` cast to the consent type is truthy, so a workflow or a
# cast can forge one, and the type system reports nothing wrong.
expect_red "consent is checked by identity, not by shape" src/runtime/workspace.ts \
  's/choice\.consent !== OPERATOR_CONSENT/!choice.consent/'

# The flag's name is gone from the sentence the operator reads. Not the *statement* of the choice —
# the substituted text still says the checkout was asked for, which is what the earlier version of
# this comment praised while claiming the mutation removed it. The narrower property is the one the
# test holds: `description` must name `LIVE_CHECKOUT_FLAG`, so the flag is spelled once in this module
# and every message naming it stays in step with the CLI that parses it (AWCLI-20).
expect_red "the live-checkout choice is stated in the isolation awcli reports" src/runtime/workspace.ts \
  's/because this run was given \$\{LIVE_CHECKOUT_FLAG\}/because you asked for it/'

# A workflow is given a channel to the axis. BR-014 puts the opt-in on the command line because the
# person whose uncommitted work is at stake has to be the one asking; a field here hands that
# decision to committed code in the repository, and nothing but the declaration's own text says so.
expect_red "a workflow cannot ask for the live checkout" src/contract/awcli.d.ts \
  's/interface SandboxOptions \{\n  \/\*\* Slot within the run\./interface SandboxOptions {\n  liveCheckout?: boolean | undefined;\n  \/** Slot within the run./'

# ── Scenario: Parallel agents never share a working copy ─────────────────────────────────────
# The slot is dropped from the path, so every slot of one run lands in one directory. Two of the
# three agents then either share a tree or are refused for a collision nobody asked for.
expect_red "Parallel agents never share a working copy" src/runtime/run-identity.ts \
  's/  return join\(runtimeRoot\(repositoryPath\), WORKTREES_DIRECTORY, runName, slot\);/  void slot;\n  return join(runtimeRoot(repositoryPath), WORKTREES_DIRECTORY, runName);/'

# And dropped from the branch name, which is the same collision one layer along: three working
# copies on one branch, so whichever agent commits last owns the history.
expect_red "each slot gets its own branch" src/runtime/run-identity.ts \
  's/  return `\$\{BRANCH_NAMESPACE\}\/\$\{runName\}\/\$\{slot\}`;/  void slot;\n  return `\${BRANCH_NAMESPACE}\/\${runName}`;/'

# ── Branch names for the same run and slot are identical across invocations ──────────────────
# A per-invocation suffix. This is what a reviewer suggests the moment a second run of one name
# collides — and it makes AWCLI-14's reattachment impossible and leaves a branch per iteration
# behind, while every other test in the suite still passes because each one derives the name once.
expect_red "the branch for a run and slot is identical across invocations" src/runtime/run-identity.ts \
  's/  return `\$\{BRANCH_NAMESPACE\}\/\$\{runName\}\/\$\{slot\}`;/  return `\${BRANCH_NAMESPACE}\/\${runName}\/\${slot}-\${process.hrtime.bigint()}`;/'

# The same defect on the path a caller with no slot to give takes: a slot allocated per invocation
# rather than a fixed default. Every run then gets a fresh working copy and a fresh branch, and
# resuming finds nothing.
expect_red "the unnamed caller's slot is fixed, not allocated per invocation" src/runtime/workspace.ts \
  's/    validated === undefined \|\| !validated\.ok \? DEFAULT_SLOT : validated\.slot;/    validated === undefined || !validated.ok ? (`slot-\${Date.now()}` as SlotName) : validated.slot;/'

# ── The working copy is registered, and preserved when it is released ────────────────────────
# Acquired without registering. What that costs is not a leak — a working copy is preserved on
# purpose, so nothing is left dangling on disk that would not have been left there anyway; the
# earlier version of this comment called it one, which is the opposite of the disposition twelve
# lines below. What is lost is the account: the unwind report is what says a working copy was
# released and preserved, so an unregistered one makes BR-021 unobservable and puts this resource
# outside the mechanism every other one goes through (ADR-0001).
expect_red "the working copy is acquired through the disposal stack" src/runtime/workspace.ts \
  's/    const workspace = await stack\.acquire\(acquisition\);/    const workspace = await acquisition.open();/'

# Registered, but destroyed rather than preserved. BR-021 states the disposition per resource: the
# lock is always released, a working copy is always preserved, because the commits on its branch are
# the deliverable and an interrupted run's work has to still be there to inspect.
expect_red "the working copy is preserved on release, not destroyed" src/runtime/workspace.ts \
  's/    disposition: "preserve",/    disposition: "destroy",/'

# And the disposition honoured in deed as well as in the report: a release that removes the tree.
# For a live checkout this is the operator's own checkout being deleted by a run ending normally,
# which is the single worst thing this file could do.
expect_red "releasing a working copy does nothing to it on disk" src/runtime/workspace.ts \
  's/    release: \(\) => \{\},/    release: async (held: WorkspaceHandle) => {\n      await (await import("node:fs\/promises")).rm(held.dir, { recursive: true, force: true });\n    },/'

# ── Provisioning is never destructive ───────────────────────────────────────────────────────
# The obvious way to make provisioning "just work": clear whatever is in the way. What is in the way
# is either a run in progress or the last one's uncommitted work, and this is the mutation that
# stands for `git worktree remove`, `--force`, a reset and a clean alike — every one of them ends
# with work that was on disk no longer being on disk.
expect_red "provisioning never removes or writes over what it finds" src/runtime/workspace.ts \
  's/  const existing = await lstatOrMissing\(target\);/  const existing = undefined;\n  await (await import("node:fs\/promises")).rm(target, { recursive: true, force: true });/'

# The check before the add is gone, so the ordinary case — a branch an earlier run of this name and
# slot left behind (BR-036) — reaches the `git branch` cut instead of being answered without it.
# The point is not that awcli would otherwise take the branch over: it cannot, `git branch` refuses a
# name that exists, and the re-check after that non-zero exit turns the same collision into the same
# refusal, so the message alone cannot tell whether awcli asked first. What asking first buys is that nothing is
# attempted and nothing is made — no doomed subprocess, and no directory created and removed inside
# the operator's repository for a run that was never going to start. The test records the git calls
# and looks for the directory, which is what makes this a red rather than an identical sentence.
expect_red "an existing branch is refused before anything is attempted" src/runtime/workspace.ts \
  's/  if \(collision !== undefined\) \{/  if (false) {/'

# A collision query that failed, read as "nothing in the way". A non-zero exit yields empty stdout,
# so an unreadable `packed-refs` is indistinguishable from a repository with no awcli branches — and
# the run walks on into `git worktree add` to fail there with git's exit status and no remedy. This
# was the state of the code while every other git call in the module inspected `.code`.
expect_red "a failed collision query is a fault, not an empty answer" src/runtime/workspace.ts \
  's/    return \{ ok: false, code: listed\.code, stderr: listed\.stderr \};/    void listed;/'

# The second look dropped, so a branch that appears between the check and the cut comes back as the
# thrown fault reserved for what awcli has no sentence for. It has one — `git branch` refuses a name
# that exists, which is the second line of defence that catches it, and the check before the cut
# cannot be the guarantee because a mkdir and a subprocess sit inside that window.
expect_red "a branch that appears in the window is refused, not thrown on" src/runtime/workspace.ts \
  's/    const late = await lateCollision\(git, repositoryPath, runName, branch\);/    void lateCollision;\n    const late = undefined;/'

# The collision check narrowed to the exact ref, which is what it was until review asked what an
# operator with a branch called `awcli` sees. git stores a branch as a file under `refs/heads/`, so a
# branch at the namespace makes every branch below it uncreatable — and without this the run lands in
# the thrown-fault branch with git's `cannot lock ref` and no next step. Verified on git 2.55.
expect_red "a branch above this one in the namespace is a refusal, not a fault" src/runtime/workspace.ts \
  's/    if \(prefix !== undefined\) \{\n      return \{/    if (false) \{\n      return {/'

# And the same collision from the other direction: a ref *beneath* the branch blocks it too. awcli
# cannot produce one of these itself — a slot may not contain a slash — so it is always a name the
# operator already had, which is exactly why it needs a sentence rather than a stack trace.
expect_red "a branch beneath this one is a refusal, not a fault" src/runtime/workspace.ts \
  's/  if \(below !== undefined\) return \{ kind: "below", ref: short\(below\) \};/  if (false) return { kind: "below", ref: short(below) };/'

# The comparison narrowed back to an exact one. git resolves a loose ref through the filesystem, and
# the APFS and NTFS defaults ignore case there — so an operator branch differing from awcli's
# namespace only in case collides in git while an exact match sees nothing, and the run exits through
# the thrown fault instead of the refusal. Only the operator's spelling can vary: awcli's own names
# are refused unless they are already lowercase.
expect_red "a ref that collides only when case is folded is still a refusal" src/runtime/workspace.ts \
  's/    return existing\.find\(\(ref\) => ref\.toLowerCase\(\) === wanted\);/    return existing.find((ref) => ref === wanted);/'

# ── The remedies a refusal names are ones git accepts ───────────────────────────────────────
# Release is a no-op and collection is AWCLI-22's, so the only cleanup an operator has today is by
# hand — and each of these refusals had, at some point, advised a command that does not run. The
# remedies are mutated rather than the checks, because on these paths the sentence *is* the fix: a
# refusal whose remedy git rejects leaves the operator with a run name they cannot use.

# The occupied refusal advises `git worktree remove` for everything, which is what it did until
# review ran it: on an ordinary directory git exits 128 with `fatal: ... is not a working tree`, and
# the branch this fires from says in its own comment that it fires for anything at all. The suite was
# green over it because it matched the sentence as a string instead of running what it says.
# The registration *answer* is forced, not the condition flipped, and that distinction is the one the
# `held` pair below documents at length: `registration === "registered"` mutated to `false` falls
# through to `registration === "unregistered"`, which is also false for a registered target, so the
# message produced is the *unknown* arm — which names both remedies and therefore satisfies either
# assertion. A mutation landing on the honest third answer proves nothing about the two confident
# ones. This pair was left behind when the sibling was fixed.
expect_red "an ordinary directory is not sent to git worktree remove" src/runtime/workspace.ts \
  's/  const registration = await worktreeRegistration\(git, repositoryPath, target\);/  const registration: WorktreeRegistration = "registered";/'

# And the other way round: a working copy git *does* have registered, told to move or delete the
# directory. That leaves the registration behind, the registration goes on holding this run's branch,
# and the branch delete then fails naming a path that is no longer there — the run name is unusable
# until the operator finds `git worktree prune` for themselves.
expect_red "a registered working copy is sent to git worktree remove" src/runtime/workspace.ts \
  's/  const registration = await worktreeRegistration\(git, repositoryPath, target\);/  const registration: WorktreeRegistration = "unregistered";/'

# The branch refusal drops what to do about the working copy still holding the branch, which is the
# same journey one step further along.
expect_red "the branch refusal says what to do about the working copy holding it" src/runtime/workspace.ts \
  's/`If it is finished with, remove the working copy that holds it first with "git worktree remove \$\{shellPath\(target\)\}" \(which works even if that directory has already gone, and "git worktree prune" clears every stale registration at once\), then "git branch -d \$\{branch\}"\.`/`Delete it yourself if it is finished with.`/'

# ── The path awcli checked and the path git uses are the same path ──────────────────────────
# `mkdir` with `recursive`, which is what anyone writes by habit — and which *follows* a final
# symlink instead of refusing it. The early `lstat` cannot cover this: between it and the add sit
# `makeLayout`'s four mkdirs and four lstats, the target's own mkdir, and a subprocess — and a link
# planted anywhere in that window sends `git worktree add` outside the repository while the handle and
# the operator-facing sentence both say it is inside.
# Reproduced on git 2.55; the suite stages the window through the git seam rather than racing for it.
expect_red "the target directory is created without following a symlink" src/runtime/workspace.ts \
  's/    await mkdir\(target\);/    await mkdir(target, { recursive: true });/'

# The other half of awcli creating that directory itself: when git then fails, the empty directory is
# left behind, and the *next* invocation refuses over it as occupied. A transient git failure becomes
# a run name blocked by awcli's own leftover — the self-inflicted window, arrived at through the fix
# for a different one.
expect_red "a failed add leaves no directory of awcli's own behind" src/runtime/workspace.ts \
  's/  await rmdir\(target\)\.catch\(ignoreCleanupFailure\);\n  \/\/ `NO_HOOKS`/  \/\/ `NO_HOOKS`/'

# A symlink in the layout is followed. `mkdir` with `recursive` follows one at any level, so a
# repository carrying a committed symlink at `.awcli` puts the working copy — and everything an
# agent writes in it — somewhere else on the operator's disk entirely.
expect_red "a symlink in the layout is refused rather than followed" src/runtime/workspace.ts \
  's/  if \(stats\.isSymbolicLink\(\)\) \{/  if (false) {/'

# And an ancestor that exists as an ordinary file, which had no sentence at all: `lstatOrMissing`
# turns ENOENT into "not there" and rethrows every other errno as it came, so a repository carrying a
# tracked file named `.awcli` produced a bare `ENOTDIR` and a stack trace from the *next* lstat.
expect_red "a file where a directory of the layout belongs is named" src/runtime/workspace.ts \
  's/  if \(!stats\.isDirectory\(\)\) \{/  if (false) {/'

# Only the outermost ancestor inspected, which is the plausible half-measure: `mkdir` with
# `recursive` follows a symlink at *any* level, so `.awcli/run` or `.awcli/run/worktrees` redirects
# the working copy just as `.awcli` does. Review found that the suite staged only `.awcli` and this
# mutation is what keeps the other two staged — run-lock.ts had the same hole and the same fix.
# Two loops walk that list now — the early check and the creation, which is what makes the second one
# a guarantee rather than a detection — so both are narrowed together: narrowing either alone leaves
# the other covering for it, and the mutation would prove nothing.
expect_red "every ancestor of the working copy is inspected, not just the first" src/runtime/workspace.ts \
  's/  for \(const ancestor of worktreePathAncestors\(repositoryPath, runName\)\) \{\n    const stats = await lstatOrMissing\(ancestor\);/  for (const ancestor of worktreePathAncestors(repositoryPath, runName).slice(0, 1)) {\n    const stats = await lstatOrMissing(ancestor);/' \
  's/  for \(const ancestor of worktreePathAncestors\(repositoryPath, runName\)\) \{\n    try \{/  for (const ancestor of worktreePathAncestors(repositoryPath, runName).slice(0, 1)) {\n    try {/'

# And the list itself one short, which is the half-measure from the other end: the run's own
# worktrees directory dropped from the ancestors, so a symlink committed at
# `.awcli/run/worktrees/<run>` redirects the working copy while every other position stays covered.
# The suite and this gate were both green over exactly this until the fourth row was staged.
expect_red "the run's own worktrees directory is an ancestor too" src/runtime/run-identity.ts \
  's/    join\(worktrees, runName\),\n  \];/  ];/'

# ── What git said went wrong is what gets quoted ────────────────────────────────────────────
# The first line of stderr, which is what this took until review read git's actual output. Only one
# command awcli runs prints progress, and it is the one that matters: `git worktree add` writes
# `Preparing worktree (...)` and then fails, so the first line is the announcement and the cause is
# thrown away — on the single path this module declares it cannot explain and therefore throws from,
# where the quoted line is the whole of the remedy.
expect_red "the line quoted from git is the one that says what went wrong" src/runtime/git-process.ts \
  's/  const line = marked \?\? lines\.at\(-1\);/  const line = lines[0];/'

# ── A missing directory is not a missing git ────────────────────────────────────────────────
# ENOENT mapped straight to "git is not installed", which is what shipped. `execFile` raises it both
# for a binary it cannot find and for a `cwd` that does not exist — same errno, same `spawn git
# ENOENT` message — so a mistyped `--repo` told the operator to install git on a machine that had it,
# and made the not-a-repository refusal unreachable by that route.
expect_red "a directory that is not there is not reported as a missing git" src/runtime/git-process.ts \
  's/        if \(!\(await isDirectory\(cwd\)\)\) return \{ kind: "no-such-directory", path: cwd \};/        void isDirectory;/'

# ── A fault is not dressed up as a refusal ──────────────────────────────────────────────────
# The catch-all: every error out of the acquisition becomes a refusal. It is what you get from
# "make the caller's life easy", and it is the one mutation the two `rejects.toThrow` tests exist
# for — a symlink redirecting the working copy, or a git failure awcli has no sentence for, would
# arrive as a named refusal claiming awcli knows what is wrong and what to do instead. Both are
# things awcli knows neither of.
expect_red "a fault comes out as a throw, not as a refusal" src/runtime/workspace.ts \
  's/    if \(error instanceof WorkspaceRefusedError\) return error\.refusal;\n    throw error;/    if (error instanceof WorkspaceRefusedError) return error.refusal;\n    return refuseWith("occupied", slot, error instanceof Error ? error.message : String(error));/'

# ── The layout is derived, never re-spelled ─────────────────────────────────────────────────
# Working copies put beside `run/` rather than under it — still inside `.awcli`, which
# `run-identity.ts` calls the runtime directory, but outside `.awcli/run`, which it calls the single
# ignored path. This is the mistake `worktreePath`'s own docblock warns about, and it is quiet:
# everything works, the branches are right, and the one generated ignore line BR-030 allows stops
# covering the working copies, so every one of them shows up as untracked in the operator's
# repository.
expect_red "working copies live under the one runtime path" src/runtime/run-identity.ts \
  's/  return join\(runtimeRoot\(repositoryPath\), WORKTREES_DIRECTORY, runName, slot\);/  return join(repositoryPath, ".awcli", WORKTREES_DIRECTORY, runName, slot);/'

# The repository path reaching the layout and git's argv unresolved. `WorkspaceHandle.dir` is
# documented absolute and `worktreePath` joins rather than resolves, so a relative repository path
# gives `ctx.fs` and `ctx.exec` a path to resolve again against their own cwd — and gives
# `git worktree add` a target argument that a leading `-` turns into an option.
expect_red "the repository path is resolved at the boundary" src/runtime/workspace.ts \
  's/  const repositoryPath = resolve\(request\.repositoryPath\);/  const repositoryPath = request.repositoryPath;/'

# ── A slot is validated, never trusted ──────────────────────────────────────────────────────
# The slot is taken as given, which is the implementation you get if you forget that a slot comes
# from a workflow rather than from awcli. `../../etc` is then a path escaping the runtime directory
# and an illegal git ref at the same time.
expect_red "a slot that would escape the runtime directory is refused" src/runtime/workspace.ts \
  's/  const validated = asked === undefined \? undefined : validateSlotName\(asked\);/  const validated = asked === undefined ? undefined : { ok: true, slot: asked };/'

# The traversal rung of the ladder a run name and a slot share — the one whose consequence lands
# outside the run's own directory, and the only rung this script mutates.
#
# What it proves, exactly: that the rung is *live*, and that something in this gate's suite asserts
# it. What it cannot prove on its own is that the *slot* half is asserted, because the rung is shared
# and run-identity.test.ts — which this gate runs — now asserts both halves against it, so a red here
# can come entirely from run-name assertions. The slot half is asserted, by the
# `a slot name is validated, never sanitised` block that moved into that file with the rest of the
# rules it belongs to, and the run-name mutations in verify-lock-gate.sh have the mirror-image
# limitation. But that is an argument, not something this substitution demonstrates. It is written
# down because a mutation that proves less than its label claims is the same class of hole as one
# that is silently skipped, which is what this script's header is about. Running the two halves as
# separate suites would demonstrate it; the cost is a second full run per mutation, and the judgement
# was that saying so is worth more than the minutes.
#
# It is also why the other two rungs are not repeated here — see the note below them.
expect_red "a slot may not contain traversal" src/runtime/run-identity.ts \
  's/  if \(name\.includes\("\.\."\)\) return "traversal";/  if (false) return "traversal";/'

# The `not-lowercase` and `git-reserved-suffix` rungs are not mutated here: verify-lock-gate.sh owns
# byte-identical substitutions against the same two lines of the shared ladder, and by the note above
# a red for either can be produced entirely by run-identity.test.ts's run-name assertions — so
# repeating them buys nothing and costs two full runs of the real-git workspace suite.

# A refused slot echoed back with its control characters, in the branch that refuses one *for*
# holding them. A slot reaches this message from a workflow, and the message goes to a terminal.
expect_red "a refused slot is not echoed back unfiltered" src/runtime/run-identity.ts \
  's/    name: printable\(name\),/    name,/'

# ── The refusals an operator acts on, as refusals rather than as faults ─────────────────────
# Each of these is a condition the operator can fix, and each arrives as a git complaint and a stack
# trace if the check is missing. The kinds are what a caller acts on, so a refusal reported as the
# wrong kind is as broken as no refusal at all.

# No git on the machine, read as something about this repository.
expect_red "a machine with no git is told so" src/runtime/workspace.ts \
  's/  if \(inside\.kind === "unavailable"\) \{/  if (false) {/'

# The not-a-repository check dropped, so a directory that is not a repository falls through to the
# next question. That used to be the HEAD query, and the operator was sent to make a commit in a
# directory git knows nothing about; since the root lookup landed between the two it is now the
# `no-working-tree` refusal, which tells them their directory is a bare repository. Either way it is a
# confident sentence about a cause awcli never established, which is what this mutation is about.
expect_red "a directory that is not a repository is refused" src/runtime/workspace.ts \
  's/  if \(inside\.code !== 0\) \{/  if (false) {/'

# A repository with no commit: there is no branch to cut a working copy from, and `git worktree add`
# fails with something an operator has to decode. One commit is the whole remedy.
expect_red "a repository with no commit is refused rather than thrown on" src/runtime/workspace.ts \
  's/  if \(head\.code === 1\) \{/  if (false) {/'

# A detached head on the live checkout, reported as an empty branch. A run's branch is what AWCLI-14
# reattaches by and what the operator reads, and neither has any meaning for a detached head — so
# inventing one is worse than refusing.
expect_red "a detached head is refused rather than reported as a branch" src/runtime/workspace.ts \
  's/  if \(branch\.length === 0\) \{/  if (false) {/'

# The two folded back into one, which is what they were. `branch --show-current` exits zero and
# answers an empty line on a detached HEAD, so a non-zero exit is something else — and on git 2.21,
# which has no `--show-current` at all, folding them refused an operator sitting on `main` with
# "check out a branch and run again": advice that cannot be taken.
expect_red "a git that could not answer is a fault, not a detached head" src/runtime/workspace.ts \
  's/  if \(current\.code !== 0\) \{/  if (false) {/'

# ── awcli's git works on the repository awcli named ─────────────────────────────────────────
# The child inherits the environment whole, which is what it did. git's discovery variables win over
# the working directory *and* over `-C`, and awcli is started by things that set them: a git hook,
# `git rebase --exec`, `git bisect run`. Inherited, `git worktree add` cuts the branch and checks the
# tree out in whatever repository `GIT_DIR` names while every sentence awcli prints names the one the
# operator asked about. Reproduced end to end on git 2.55.
expect_red "git is run against the directory awcli named, not the one the environment names" src/runtime/git-process.ts \
  's/        env: gitEnvironment\(\),/        env: process.env,/'

# The discovery variables stripped and the config family left, which is the half-measure: `-c` is not
# the only way to set `core.hooksPath`, and `GIT_CONFIG_COUNT` with its `KEY_n`/`VALUE_n` sets any
# configuration at all for every invocation in the process.
expect_red "an injected git configuration does not reach the child either" src/runtime/git-process.ts \
  's/      GIT_CONFIG_INJECTORS\.includes\(name\) \|\|\n      GIT_CONFIG_INJECTOR_PREFIXES\.some\(\(prefix\) => name\.startsWith\(prefix\)\)\n/      false\n/'

# And the other direction, which the prefix rule got wrong: `GIT_CONFIG_GLOBAL` and
# `GIT_CONFIG_SYSTEM` point *at* configuration rather than injecting it, and `/dev/null` in either is
# how a caller runs git without the operator's and the machine's. Swept up by
# `name.startsWith("GIT_CONFIG")`, awcli silently handed that configuration back — undoing a hardening
# the caller had asked for, and making the real-git suites read the developer's own `~/.gitconfig` on
# every run while looking hermetic. Passing them through is a decision, so something has to watch it.
expect_red "a caller's own git configuration switch survives the scrub" src/runtime/git-process.ts \
  's/      GIT_CONFIG_INJECTORS\.includes\(name\) \|\|/      name.startsWith("GIT_CONFIG") ||/'

# A git killed by something that is not awcli's own timeout, left to the raw rethrow. `code` is null
# and `killed` is false for it, so it matched no branch — and an OOM-killed `git worktree add` on a
# large repository reached the operator as execFile's `Command failed: git ...`, out of the module
# whose stated job is telling its failures apart.
expect_red "a git killed by a signal is named rather than rethrown raw" src/runtime/git-process.ts \
  's/        failure\.killed !== true &&/        false \&\&\n        failure.killed !== true \&\&/'

# git failing silently, answered with silence. Every caller interpolates the complaint after a full
# stop, so the empty string produced `... exited 128. ` — a trailing space, no cause, and a sentence
# that reads as truncated.
expect_red "a git that printed nothing says so" src/runtime/git-process.ts \
  's/  return line === undefined \? NO_COMPLAINT : printable\(line, GIT_COMPLAINT_LIMIT\);/  return line === undefined ? "" : printable(line, GIT_COMPLAINT_LIMIT);/'

# ── Provisioning runs no code out of the repository ─────────────────────────────────────────
# The hooks left on, which is what `git worktree add` does by default: a checkout runs
# `post-checkout`, resolved through the common git dir that every slot's working copy shares. An
# agent in one slot writes it and the next acquisition — any run, any slot — executes it on the host
# with the operator's identity, before any execution boundary exists.
expect_red "provisioning runs none of the repository's own hooks" src/runtime/workspace.ts \
  's/    \[\.\.\.NO_HOOKS, "worktree", "add", target, branch\],/    ["worktree", "add", target, branch],/'

# ── The collision question is asked of the whole repository ─────────────────────────────────
# The query narrowed back to awcli's namespace. git matches a `for-each-ref` pattern
# case-sensitively while the comparison below folds case, so a branch called `AWCLI` was never in the
# list the fold folds — the fold had nothing to fold against, and the case it exists for reached
# `git worktree add` and came back as `exited 128` with no remedy. Verified on git 2.55.
expect_red "every branch is a collision candidate, not just the ones git's pattern matched" src/runtime/workspace.ts \
  's/    \["for-each-ref", "--format=%\(refname\)", "refs\/heads"\],/    ["for-each-ref", "--format=%(refname)", `refs\/heads\/\${BRANCH_NAMESPACE}`],/'

# ── The branch refusal names the removal only when there is one to remove ───────────────────
# Both directions, as for the occupied refusal: this path is reached only after `occupied` has
# established that nothing is at the target, so the live cases are a registration whose directory has
# been deleted and a branch nothing has ever held. `git worktree remove` is exactly right for the
# first and exits 128 with `fatal: ... is not a working tree` for the second.
# The answer is forced rather than the condition flipped, and that distinction cost a gate run: with
# `held === "registered"` mutated to `false`, the ternary falls through to the *unknown* arm, which
# names both remedies and so satisfies both tests. A mutation that lands on the honest third answer
# proves nothing about the two confident ones. Forcing the registration answer itself is also the
# more faithful wrong implementation: what this replaced was a message that assumed one of them.
expect_red "a branch no working copy holds is not sent to git worktree remove" src/runtime/workspace.ts \
  's/    const held = await worktreeRegistration\(git, repositoryPath, target\);/    const held: WorktreeRegistration = "registered";/'

expect_red "a branch a registered working copy still holds names the removal" src/runtime/workspace.ts \
  's/    const held = await worktreeRegistration\(git, repositoryPath, target\);/    const held: WorktreeRegistration = "unregistered";/'

# ── A refusal never names a command that discards commits ───────────────────────────────────
# `-D` restored, which is what every branch remedy said. It force-deletes the branch the same sentence
# calls the deliverable, and today it is the *only* cleanup path a run has — release is inert and
# collection is AWCLI-22's — so an operator following awcli's own advice after a run that committed
# lost the work with no second question. `-d` refuses an unmerged branch and prints git's `-D` hint
# itself, so insisting stays one paste away. Reproduced both ways on git 2.55.
expect_red "the branch remedy refuses rather than discards, on the arm that names the removal" src/runtime/workspace.ts \
  's/clears every stale registration at once\), then "git branch -d \$\{branch\}"\./clears every stale registration at once), then "git branch -D \$\{branch\}"./'

expect_red "the branch remedy refuses rather than discards, on the arm with nothing to remove first" src/runtime/workspace.ts \
  's/"git branch -d \$\{branch\}" deletes it — git has no working copy registered at/"git branch -D \$\{branch\}" deletes it — git has no working copy registered at/'

expect_red "the occupied remedy refuses rather than discards" src/runtime/workspace.ts \
  's/and then "git branch -d \$\{branch\}" if the branch is finished with too\./and then "git branch -D \$\{branch\}" if the branch is finished with too./'

# ── A branch another run is provisioning onto right now is not cleanup advice ────────────────
# The second look dropped, which is how this shipped. Cutting the branch in its own call put the
# winner's ref immediately after its own `mkdir`, so a loser's collision query routinely finds a branch
# a live run cut a moment ago — and all three remedies below then read as a settled world: remove the
# working copy at that path, delete that branch. `held === "registered"` is *true* in that state,
# because the winner has just registered it. Reaching this site means the target was free when awcli
# looked, and a winner whose branch exists has already created the directory, so something being there
# now is the evidence — the same class as EEXIST from `mkdir` on the occupied path.
expect_red "a branch a run is provisioning onto right now is not sent to git worktree remove" src/runtime/workspace.ts \
  's/    if \(arrived !== undefined\) \{/    if (false) \{/'

# And the question dropped altogether: `worktreeRegistration` asks git through the raw runner, which
# throws for a timeout and for an answer larger than awcli reads. Unguarded, that rejection escapes
# the refusal it was building and an occupied target comes back as a fault.
expect_red "a git that could not be asked is not a confident registration answer" src/runtime/workspace.ts \
  's/  const listed = await git\(\["worktree", "list", "--porcelain"\], repositoryPath\)\.catch\(\n    \(\) => undefined,\n  \);/  const listed = await git(["worktree", "list", "--porcelain"], repositoryPath);/'

# ── The layout is built where the repository starts ─────────────────────────────────────────
# The directory git was asked from used as the root. `rev-parse --git-dir` exits 0 from every
# subdirectory of a repository, so `--repo /repo/packages/api` passes every check and then puts a
# second `.awcli/run` inside the repository — holding a whole checkout the one generated ignore line
# (BR-030) does not cover, while the branch is cut in the repository above.
expect_red "the layout follows the repository root, not the directory git was asked from" src/runtime/workspace.ts \
  's/  return \{ root, head: head\.stdout\.trim\(\) \};/  return { root: repositoryPath, head: head.stdout.trim() };/'

# ── awcli writes nothing through a symlink, and says where the working copy landed ──────────
# `mkdir` with `recursive` for the ancestors, which is what this was: it follows a link at any level
# and creates every level in one act, so a link planted after the early check had awcli create the
# run's whole directory tree inside the link's destination — outside the repository — before the
# second check looked and threw. The refusal has to precede the writing, not report it.
expect_red "the layout is created one level at a time rather than through a symlink" src/runtime/workspace.ts \
  's/  await makeLayout\(repositoryPath, runName\);/  await mkdir(dirname(target), { recursive: true });/'

# And the answer that cannot be raced ahead of, dropped. Every check above is checked-then-used and
# node offers nothing to make the check and the use one act, so where the working copy *is* once git
# has finished with it is the last word. Without it a tree outside the repository comes back as a
# handle whose `dir` says it is inside.
expect_red "a working copy that landed outside the runtime directory is a fault" src/runtime/workspace.ts \
  's/  await assertInsideRuntimeDirectory\(repositoryPath, target\);/  void assertInsideRuntimeDirectory;/'

# ── A guess is not a diagnosis ──────────────────────────────────────────────────────────────
# Any non-zero exit from the HEAD query read as "no commit yet", which is what it was. A repository
# awcli cannot read — dubious ownership, a HEAD pointing at a missing ref — exits 128, and the
# operator with a full history was told to make their first commit. `--verify --quiet` exits 1 for
# the one case the refusal is about.
expect_red "a HEAD git could not read is not a repository with no commit" src/runtime/workspace.ts \
  's/  if \(head\.code === 1\) \{/  if (head.code !== 0) {/'

# And git's own complaint dropped from the not-a-repository refusal — the only two calls in the
# module that discarded it. `fatal: detected dubious ownership` carries the exact remedy, and awcli
# replaced it with a sentence about a cause it never established.
expect_red "the not-a-repository refusal carries what git said" src/runtime/workspace.ts \
  's/ Run awcli from a repository, or point it at one\. git said: \$\{gitComplaint\(inside\.stderr\)\}`,/ Run awcli from a repository, or point it at one.`,/'

# ── The sentences an operator meets on their worst day ──────────────────────────────────────
# An unwritable repository, back to a bare errno and a stack trace. This is the one fault on the
# path an operator can fix without knowing anything about awcli, and it had no test at all until
# workspace-fs-faults.test.ts: the body of this function could be deleted with the suite green.
expect_red "an unwritable repository is a sentence, not a bare errno" src/runtime/workspace.ts \
  's/  if \(isErrno\(error, "EACCES"\) \|\| isErrno\(error, "EPERM"\) \|\| isErrno\(error, "EROFS"\)\) \{/  if (false) {/'

# git becoming unavailable *during* an acquisition, read as the refusal for a machine with no git —
# whose remedy is to install git on a machine that had it a moment ago.
expect_red "a git that goes missing mid-acquisition is a fault, not a machine with no git" src/runtime/workspace.ts \
  's/  if \(outcome\.kind === "unavailable"\) \{/  if (false) {/'

# And the repository being removed underneath the run, which the preflight established was there.
expect_red "a repository that goes missing mid-acquisition says it was there when the run started" src/runtime/workspace.ts \
  's/  if \(outcome\.kind === "no-such-directory"\) \{/  if (false) {/'

# The handle's own two questions, reduced to git's exit status. `head()` is what the run records
# against itself (BR-025) and `dirty()` is what a resumed run inherits, so neither may answer with
# less than which working copy could not answer and what git said about it.
expect_red "a working copy that cannot say what commit it is on says which one and why" src/runtime/workspace.ts \
  's/          `awcli could not read the commit the working copy at \$\{dir\} is on: git rev-parse exited \$\{answer\.code\}\. \$\{gitComplaint\(answer\.stderr\)\}`,/          `git rev-parse exited \${answer.code}.`,/'

expect_red "a working copy that cannot say whether it is dirty says which one and why" src/runtime/workspace.ts \
  's/          `awcli could not tell whether the working copy at \$\{dir\} has uncommitted changes: git status exited \$\{answer\.code\}\. \$\{gitComplaint\(answer\.stderr\)\}`,/          `git status exited \${answer.code}.`,/'

# ── What the operator reads is what awcli wrote ─────────────────────────────────────────────
# The live checkout's branch name taken from git verbatim. awcli's own branch names are refused
# unless they are already lowercase and plain, but this one is whatever the repository has — and
# git's ref rules permit the bidirectional format characters, which reverse the rendering of
# everything after them in the sentence BR-015 asks for.
expect_red "the operator's own branch name is sanitised before it is printed" src/runtime/workspace.ts \
  's/  const branch = printable\(current\.stdout\.trim\(\), PATH_LIMIT\);/  const branch = current.stdout.trim();/'

# ── A run that is unwinding gives one answer ────────────────────────────────────────────────
# The slot check decided before the stack, which is where it was. `DisposalStack.acquire` refuses
# once an unwind has begun, so a check outside it goes on answering during shutdown: one in-flight
# `sandbox()` is told its slot name is illegal — implying a workflow bug — while its sibling in the
# same moment is told the run is closing.
expect_red "an unwinding run answers the same way whatever the refusal would have been" src/runtime/workspace.ts \
  's/    const workspace = await stack\.acquire\(acquisition\);/    if (validated !== undefined \&\& !validated.ok) return invalidSlot(validated);\n    const workspace = await stack.acquire(acquisition);/'

# ── The boundary is not resolved through the link it exists to catch ────────────────────────
# `realpath(worktreesRoot(...))` for the boundary, which is what this was. Both sides then resolve
# after the working copy exists and through the same layout, so a link at `.awcli`, `.awcli/run` or
# `worktrees` moves the boundary along with the target and the comparison succeeds on the far side of
# the escape. Reproduced against git 2.55: the handle said `.awcli/run/worktrees/<run>/<slot>`, the
# checkout was outside the repository, and nothing threw. Only a link at `worktrees/<run>` or at the
# leaf was caught — and the leaf was the only case the suite staged.
expect_red "the boundary is derived from the repository root, not from the layout as it stands" src/runtime/workspace.ts \
  's/      : join\(root, relative\(repositoryPath, worktreesRoot\(repositoryPath\)\)\);/      : await realpath(worktreesRoot(repositoryPath));/'

# The boundary widened to the repository, which is the reviewer's suggestion and the wrong one:
# "inside the repository" is not the property this module promises. A target redirected to
# `<repo>/somewhere-else` would then be accepted, and git would check the whole tree out there while
# `WorkspaceHandle.dir` and the BR-015 sentence both name the runtime directory.
expect_red "the boundary is the runtime directory, not the repository" src/runtime/workspace.ts \
  's/      : join\(root, relative\(repositoryPath, worktreesRoot\(repositoryPath\)\)\);/      : root;/'

# And the trailing separator dropped — the classic prefix bug, one character wide and silent. A
# sibling whose name merely starts with the boundary (`.awcli/run/worktrees-elsewhere/x`) passes.
expect_red "a sibling whose name starts with the boundary is still outside it" src/runtime/workspace.ts \
  's/    !placed\.startsWith\(`\$\{boundary\}\$\{sep\}`\)/    !placed.startsWith(boundary)/'

# ── awcli deletes the branch its own failed add cut, and nothing else ───────────────────────
# The claim forced, which is the remedy a reviewer reaches for the moment a collision is inconvenient:
# `git branch -f` takes the name whatever is on it. The run then proceeds on a branch whose commits it
# has just thrown away — and the commits on a branch are, by this module's own docblock, the
# deliverable. Nothing here may move a ref that is not awcli's.
expect_red "the branch is claimed, never taken over" src/runtime/workspace.ts \
  's/\[\.\.\.NO_HOOKS, "branch", branch, head\]/[...NO_HOOKS, "branch", "-f", branch, head]/'

# The hooks left on for the *cut*, which is where they arrived: splitting `git worktree add -b` into a
# `git branch` of its own added a mutating git call and put `NO_HOOKS` on the add's argv only. A ref
# update runs `reference-transaction` — same shared git dir, same shared `core.hooksPath`, one call
# earlier than `post-checkout` — so for a commit this was the first thing a provisioning did with the
# operator's identity, and `describe` told the operator no hook had run. The add's mutation cannot see
# this: it only ever mutated the add's arm.
expect_red "provisioning runs no hook for the branch it cuts either" src/runtime/workspace.ts \
  's/\[\.\.\.NO_HOOKS, "branch", branch, head\]/["branch", branch, head]/'

# And on the tidying after a failed add, which is the third mutating call and the one that runs when
# the operator is already being handed a fault.
expect_red "the branch awcli deletes after a failed add runs no hook either" src/runtime/workspace.ts \
  's/await git\(\[\.\.\.NO_HOOKS, "branch", "-D", branch\], repositoryPath\)/await git(["branch", "-D", branch], repositoryPath)/'

# The cut's own two guards, which arrived with neither a test nor an anchor while the add's identical
# pair had both. Deleting either left the suite green at 126 of 126 and leaked awcli's own empty
# directory — which is what the *next* invocation of this run and slot is refused `occupied` over.
expect_red "a branch cut that git refuses leaves no directory of awcli's own behind" src/runtime/workspace.ts \
  's/  if \(cut\.code !== 0\) \{\n    await rmdir\(target\)\.catch\(ignoreCleanupFailure\);/  if (cut.code !== 0) \{/'

expect_red "a branch cut the runner threw out of leaves no directory of awcli's own behind" src/runtime/workspace.ts \
  's/\.catch\(\n    async \(error: unknown\) => \{\n      await rmdir\(target\)\.catch\(ignoreCleanupFailure\);\n      throw error;\n    \},\n  \);/;/'

# And the sentence that carries git's own complaint about the cut, which could be emptied with the
# suite green: the same class as the messages `workspace-fs-faults.test.ts` exists for.
expect_red "a branch cut awcli has no sentence for carries what git said" src/runtime/workspace.ts \
  's/      `awcli could not cut the branch \$\{branch\} for the "\$\{runName\}" run: git branch exited \$\{cut\.code\}\. \$\{gitComplaint\(cut\.stderr\)\}`,/      "awcli could not cut the branch.",/'

# The branch left behind when the add then fails. Cutting it in its own call is what makes a failed
# add's leftover knowably awcli's — but a claim that is never undone is the
# same leak by another route: a commitless branch, at the name this run and slot derive, making the
# run name unusable on every later invocation until the operator deletes it by hand.
expect_red "a failed add leaves no branch of awcli's own behind" src/runtime/workspace.ts \
  's/  await git\(\[\.\.\.NO_HOOKS, "branch", "-D", branch\], repositoryPath\)\.catch\(\(\) => undefined\);/  void branch;/'

# And the tidying skipped on the throw rather than the non-zero exit. `run` throws for a git that has
# gone missing and for a `cwd` that has; the raw runner throws for the timeout, for `maxBuffer`, and
# for a child killed by a signal. On any of those the target was claimed and nothing put it back, so
# the next invocation of this run and slot was refused `occupied` over awcli's own empty leftover.
expect_red "what awcli made goes back when the runner throws, not only when git exits" src/runtime/workspace.ts \
  's/  \)\.catch\(async \(error: unknown\) => \{\n    await undoOwnBranch\(git, repositoryPath, branch, target\);\n    throw error;\n  \}\);/  );/'

# ── A remedy is offered only where it can be taken ──────────────────────────────────────────
# `--name` offered for a collision at the namespace root, which is what both prefix sentences did.
# `refs/heads/awcli` blocks every branch under `awcli/` whatever the run is called, so that half of
# the advice is dead — and the test that covered it asserted the message contained "--name", so the
# suite was green over exactly the part that does not work. Verified on git 2.55.
expect_red "a different run name is offered only where a different run name helps" src/runtime/workspace.ts \
  's/    collision\.kind === "namespace" \? "" : " Or run this under a different --name\.";/    " Or run this under a different --name.";/'

# And withheld from the occupied refusal, which is where it is cheapest and safest: it touches nothing
# that is already on disk, on the one branch whose other remedies are `git worktree remove`,
# `git branch -d` and "move it or delete it yourself".
expect_red "an occupied target offers a different run name too" src/runtime/workspace.ts \
  's/ \$\{remedy\} Or run this under a different --name\.`;/ \${remedy}`;/'

# The path in a remedy left unquoted, which is how every one of them was printed. The repository root
# is whatever the operator's disk says — `~/My Projects/repo` — so the command they were told to run
# split on the space and git answered with a usage error. Same class as naming the wrong command, one
# layer down: the suite matched the sentence instead of running it.
expect_red "a remedy naming a path is a command that runs" src/runtime/workspace.ts \
  's/  return `'"'"'\$\{printable\(path, COMMAND_PATH_LIMIT\)\.replaceAll\("'"'"'", `'"'"'\\\\'"'"''"'"'`\)\}'"'"'`;/  return printable(path, COMMAND_PATH_LIMIT);/'

# ── An answer that is still changing is not an answer ───────────────────────────────────────
# The raced discovery folded back into the settled one, which is where it was. The loser's `mkdir`
# fails while the winner's `git worktree add` is still running, so `worktree list` has nothing
# registered at the target yet and the `unregistered` arm fires: "git has no working copy registered
# there ... move it or delete it yourself", about a directory that a second later holds another run's
# live agent. Measured 8 times out of 8.
expect_red "a target awcli raced for is not described as a settled one" src/runtime/workspace.ts \
  's/  if \(occupancy === "raced"\) \{/  if (false) \{/'

# ── The handle answers about the working copy, not about the operator's configuration ───────
# `status.showUntrackedFiles=no` is a common setting on a large repository, and under it
# `git status --porcelain` says nothing about untracked files at all — which is exactly what `dirty()`
# is documented to report, since an untracked file is something a resumed run inherits. Unpinned, the
# answer differs between the operator's machine and CI's, silently and in the unsafe direction.
expect_red "whether a working copy is dirty does not depend on the operator's status configuration" src/runtime/workspace.ts \
  's/        \["-c", "status\.showUntrackedFiles=normal", "status", "--porcelain"\],/        ["status", "--porcelain"],/'

# ── A ref out of the operator's repository is sanitised before it is printed ────────────────
# The colliding branch name taken from `for-each-ref` verbatim. It is a name from the operator's
# repository, git's ref rules permit the bidirectional format characters, and both branch-exists
# messages interpolate it — so `awcli/<run>/<slot>/<U+202E>...` reverses the rendering of everything
# after it in a sentence an operator reads in a terminal. This is the function the live-checkout half's
# comment cites as the case already handled; it had neither a test nor a mutation.
expect_red "a colliding branch name is sanitised before it is printed" src/runtime/workspace.ts \
  's/  const short = \(ref: string\): string => printable\(ref\.slice\("refs\/heads\/"\.length\)\);/  const short = (ref: string): string => ref.slice("refs\/heads\/".length);/'

# ── The slot travels on the outcome, not only in the sentence ───────────────────────────────
# The handle's slot fixed to the default. Three parallel agents then report one slot between them,
# while their directories and branches — which the rest of the suite checks — stay correct. What is
# lost is the log and the run record's account of which agent this was.
expect_red "the handle reports the slot it was provisioned for" src/runtime/workspace.ts \
  's/  return \{\n    dir,\n    branch,\n    slot,/  return \{\n    dir,\n    branch,\n    slot: DEFAULT_SLOT,/'

# And the refusal's slot taken from the fallback rather than from what was asked for — so the one
# field whose value is guaranteed to hold something the rules refused reports `main` instead.
expect_red "a refused slot is reported as it was asked for" src/runtime/workspace.ts \
  's/      "invalid-slot",\n      refusal\.name,/      "invalid-slot",\n      slot,/'

# ── A bare repository is the operator'"'"'s to fix ─────────────────────────────────────────────────
# Thrown rather than refused, which is what it was — defended by "there is no different flag to
# offer". That is the wrong test: what settles the channel is whether the operator can fix it, and the
# remedy is the same one `not-a-repository` gives. The gate chain prints a refusal as a remedy and a
# throw as a stack trace.
expect_red "a bare repository is a refusal, not a fault" src/runtime/workspace.ts \
  's/    refuse\(\n      "no-working-tree",/    throw new Error(\n      \/* no-working-tree *\/ ""+/'

# ── A git that hangs is named as one ────────────────────────────────────────────────────────
# The timeout branch, which had neither a test nor an anchor here until `createGitRunner` took a
# bound: `GIT_TIMEOUT_MS` is two minutes and nothing could wait for it. Removed, a timed-out child has
# `code === null`, so the string-errno branch does not match either and the error falls to the bare
# rethrow — `Command failed: git ...`, which is precisely the outcome the sibling signal branch was
# added to prevent, out of the module whose stated job is telling its failures apart. A hang is one of
# the three failures that module says it exists for.
expect_red "a git that did not finish inside the bound is named rather than rethrown raw" src/runtime/git-process.ts \
  's/      if \(failure\.killed === true\) \{/      if (false) \{/'

mutation_gate_finish "each workspace criterion has a test that fails when it is broken"
