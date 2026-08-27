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

mutation_gate_init \
  "test/runtime/workspace.test.ts test/runtime/run-identity.test.ts" \
  src/runtime/workspace.ts src/runtime/run-identity.ts src/contract/awcli.d.ts

# ── Scenario: The default protects my checkout ───────────────────────────────────────────────
# The dispatch goes to the live checkout whichever axis was chosen. This is what you get from a
# condition written the wrong way round, and every worktree assertion in the suite still has a
# directory and a branch to look at — it is just the operator's own.
expect_red "The default protects my checkout" src/runtime/workspace.ts \
  's/      return choice\.workspace === "liveTree"/      return true/'

# The resolver defaults to the live checkout, so nothing has to be passed to get it. The whole
# design rests on the safe choice being the one you reach by asking for nothing.
expect_red "asking for nothing gives a worktree" src/runtime/workspace.ts \
  's/  return request\.liveCheckout === true/  return true/'

# The handle reports the repository rather than the worktree it just made, so `ctx.fs` and
# `ctx.exec` would operate in the operator's checkout while the run reports a worktree. One
# character of difference at the call site, and the worktree is still created — so a test that only
# looks at what exists on disk passes.
expect_red "the handle reports the working copy's own directory" src/runtime/workspace.ts \
  's/  return handle\(git, target, branch, slot, "worktree"\);/  return handle(git, repositoryPath, branch, slot, "worktree");/'

# ── Scenario: Working on the live checkout requires asking for it ────────────────────────────
# The consent check is gone: anyone naming the axis gets the operator's checkout. This is the state
# the code is in before BR-014 is thought about at all.
expect_red "the live checkout requires the operator's consent" src/runtime/workspace.ts \
  's/  if \(choice\.workspace === "liveTree" && choice\.consent !== OPERATOR_CONSENT\) \{/  if (false) {/'

# Consent checked by truthiness rather than by identity — which is what a `boolean` or a
# structurally-typed marker degrades to. `{}` cast to the consent type is truthy, so a workflow or a
# cast can forge one, and the type system reports nothing wrong.
expect_red "consent is checked by identity, not by shape" src/runtime/workspace.ts \
  's/choice\.consent !== OPERATOR_CONSENT/!choice.consent/'

# The choice is not stated in what the operator reads. BR-015 asks for the isolation a call actually
# had to be reported, and "you are working in your own checkout because you asked for it" is the one
# sentence that cannot be inferred from anywhere else.
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
  's/  const slot: SlotName = validated === undefined \? DEFAULT_SLOT : validated\.slot;/  const slot: SlotName = validated === undefined ? (`slot-\${Date.now()}` as SlotName) : validated.slot;/'

# ── The working copy is registered, and preserved when it is released ────────────────────────
# Acquired without registering. The worktree is provisioned correctly and outlives the run with
# nothing accounting for it — the leak the disposal stack exists to make impossible.
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

# The branch is taken over instead of refused. A branch outlives the run that made it (BR-036), so
# meeting one is ordinary — and awcli deleting or moving one is the deliverable going missing.
expect_red "an existing branch is refused, not taken over" src/runtime/workspace.ts \
  's/  if \(collision !== undefined\) \{/  if (false) {/'

# The collision check narrowed to the exact ref, which is what it was until review asked what an
# operator with a branch called `awcli` sees. git stores a branch as a file under `refs/heads/`, so a
# branch at the namespace makes every branch below it uncreatable — and without this the run lands in
# the thrown-fault branch with git's `cannot lock ref` and no next step. Verified on git 2.55.
expect_red "a branch above this one in the namespace is a refusal, not a fault" src/runtime/workspace.ts \
  's/  if \(prefix !== undefined\) return \{ kind: "prefix", ref: printable\(prefix\) \};/  if (false) return { kind: "prefix", ref: printable(prefix) };/'

# And the same collision from the other direction: a ref *beneath* the branch blocks it too. awcli
# cannot produce one of these itself — a slot may not contain a slash — so it is always a name the
# operator already had, which is exactly why it needs a sentence rather than a stack trace.
expect_red "a branch beneath this one is a refusal, not a fault" src/runtime/workspace.ts \
  's/  if \(below !== undefined\) \{/  if (false) {/'

# ── The remedies a refusal names are ones git accepts ───────────────────────────────────────
# Release is a no-op and collection is AWCLI-22's, so the only cleanup an operator has today is by
# hand — and the obvious advice is the advice that costs them their run name. Deleting the working
# copy's directory leaves git's registration for it, the registration goes on holding the branch, and
# `git branch -D` then fails naming a path that is not there any more. Both messages are mutated
# because both were wrong: this is a case where the sentence *is* the fix.
expect_red "the occupied refusal names a removal that clears git's registration too" src/runtime/workspace.ts \
  's/Otherwise clear it with "git worktree remove \$\{target\}", which is the removal to use rather than deleting the directory: git holds a registration for a working copy as well, and a registration left behind goes on holding this run'"'"'s branch\. That command refuses while there is uncommitted work in there, which is the answer you want\./Otherwise move or delete that directory and run again./'

expect_red "the branch refusal says what to do about the working copy holding it" src/runtime/workspace.ts \
  's/If it is finished with, remove the working copy that holds it first with "git worktree remove \$\{target\}" \(which works even if that directory has already gone, and "git worktree prune" clears every stale registration at once\), then "git branch -D \$\{branch\}"\./Delete it yourself if it is finished with./'

# A symlink in the layout is followed. `mkdir` with `recursive` follows one at any level, so a
# repository carrying a committed symlink at `.awcli` puts the working copy — and everything an
# agent writes in it — somewhere else on the operator's disk entirely.
expect_red "a symlink in the layout is refused rather than followed" src/runtime/workspace.ts \
  's/    if \(stats\.isSymbolicLink\(\)\) \{/    if (false) {/'

# Only the outermost ancestor inspected, which is the plausible half-measure: `mkdir` with
# `recursive` follows a symlink at *any* level, so `.awcli/run` or `.awcli/run/worktrees` redirects
# the working copy just as `.awcli` does. Review found that the suite staged only `.awcli` and this
# mutation is what keeps the other two staged — run-lock.ts had the same hole and the same fix.
expect_red "every ancestor of the working copy is inspected, not just the first" src/runtime/workspace.ts \
  's/  for \(const ancestor of worktreePathAncestors\(repositoryPath, runName\)\) \{/  for (const ancestor of worktreePathAncestors(repositoryPath, runName).slice(0, 1)) {/'

# ── A fault is not dressed up as a refusal ──────────────────────────────────────────────────
# The catch-all: every error out of the acquisition becomes a refusal. It is what you get from
# "make the caller's life easy", and it is the one mutation the two `rejects.toThrow` tests exist
# for — a symlink redirecting the working copy, or a git failure awcli has no sentence for, would
# arrive as a named refusal claiming awcli knows what is wrong and what to do instead. Both are
# things awcli knows neither of.
expect_red "a fault comes out as a throw, not as a refusal" src/runtime/workspace.ts \
  's/    if \(error instanceof WorkspaceRefusedError\) return error\.refusal;\n    throw error;/    if (error instanceof WorkspaceRefusedError) return error.refusal;\n    return refuseWith("occupied", slot, error instanceof Error ? error.message : String(error));/'

# ── The layout is derived, never re-spelled ─────────────────────────────────────────────────
# Working copies put beside the runtime directory rather than inside it. This is the mistake
# `worktreePath`'s own docblock warns about, and it is quiet: everything works, the branches are
# right, and the single generated ignore line — `run/`, which BR-030 says is the only ignored path —
# stops covering the working copies, so every one of them shows up as untracked in the operator's
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

# The rules themselves, one rung at a time, in the ladder a run name and a slot share.
#
# What these three prove, exactly: that the rung is *live*, and that something in this gate's suite
# asserts it. What they cannot prove on their own is that the *slot* half is asserted, because this
# gate's suite includes run-identity.test.ts, so a red here can come entirely from run-name
# assertions. The slot half is asserted — `a slot name is validated, never sanitised` runs the same
# rungs against slots, and the four run-name mutations in verify-lock-gate.sh have the mirror-image
# limitation — but that is an argument, not something these substitutions demonstrate. It is written
# down because a mutation that proves less than its label claims is the same class of hole as one
# that is silently skipped, which is what this script's header is about. Splitting the suite in two
# would demonstrate it; the cost is running every workspace scenario twice per mutation, and the
# judgement was that saying so is worth more than the minutes.
#
# Each rung was a correction to the run name's own validator, and a hand-written second copy for
# slots would have had none of them — which is the argument for one ladder.
expect_red "a slot may not contain traversal" src/runtime/run-identity.ts \
  's/  if \(name\.includes\("\.\."\)\) return "traversal";/  if (false) return "traversal";/'

expect_red "a slot that only differs by case is refused" src/runtime/run-identity.ts \
  's/  if \(name !== name\.toLowerCase\(\)\) return "not-lowercase";/  if (false) return "not-lowercase";/'

expect_red "a slot git will refuse as a branch is refused here" src/runtime/run-identity.ts \
  's/  if \(name\.endsWith\("\.lock"\)\) return "git-reserved-suffix";/  if (false) return "git-reserved-suffix";/'

# A refused slot echoed back with its control characters, in the branch that refuses one *for*
# holding them. A slot reaches this message from a workflow, and the message goes to a terminal.
expect_red "a refused slot is not echoed back unfiltered" src/runtime/run-identity.ts \
  's/        `"\$\{printable\(slot\)\}" is not usable as a slot name/        `"\${slot}" is not usable as a slot name/'

# ── The refusals an operator acts on, as refusals rather than as faults ─────────────────────
# Each of these is a condition the operator can fix, and each arrives as a git complaint and a stack
# trace if the check is missing. The kinds are what a caller acts on, so a refusal reported as the
# wrong kind is as broken as no refusal at all.

# No git on the machine, read as something about this repository.
expect_red "a machine with no git is told so" src/runtime/workspace.ts \
  's/  if \(inside\.kind === "unavailable"\) \{/  if (false) {/'

# A directory that is not a repository, which awcli cannot make a working copy from.
expect_red "a directory that is not a repository is refused" src/runtime/workspace.ts \
  's/  if \(inside\.code !== 0\) \{/  if (false) {/'

# A repository with no commit: there is no branch to cut a working copy from, and `git worktree add`
# fails with something an operator has to decode. One commit is the whole remedy.
expect_red "a repository with no commit is refused rather than thrown on" src/runtime/workspace.ts \
  's/  if \(head\.code !== 0\) \{/  if (false) {/'

# A detached head on the live checkout, reported as an empty branch. A run's branch is what AWCLI-14
# reattaches by and what the operator reads, and neither has any meaning for a detached head — so
# inventing one is worse than refusing.
expect_red "a detached head is refused rather than reported as a branch" src/runtime/workspace.ts \
  's/  if \(current\.code !== 0 \|\| branch\.length === 0\) \{/  if (current.code !== 0) {/'

mutation_gate_finish "each workspace criterion has a test that fails when it is broken"
