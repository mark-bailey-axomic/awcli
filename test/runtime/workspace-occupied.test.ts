import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DisposalStack } from "../../src/runtime/disposal.js";
import { DEFAULT_SLOT, worktreePath } from "../../src/runtime/run-identity.js";
import { systemGitRunner, type GitRunner } from "../../src/runtime/git-process.js";
import { acquireWorkspace, resolveWorkspaceChoice } from "../../src/runtime/workspace.js";
import {
  git,
  repository,
  branches,
  isWorktreeAdd,
  shell,
  TRIAGE,
  track,
  worktreeCount,
} from "./workspace-support.js";

/**
 * An occupied target, and the window between checking it and using it.
 */
describe("what provisioning refuses rather than does: something at the target", () => {
  /**
   * An ordinary directory in the way, which is not a working copy git knows anything about.
   *
   * The remedy has to fit what is actually there, and this test runs both halves against git rather
   * than matching the sentence as a string: `git worktree remove` on a plain directory exits 128
   * with `fatal: ... is not a working tree`, asserted below, so a message advising it here would
   * hand the operator a command that refuses and no second idea. The registered case, where the
   * opposite remedy is the one that works, is the test directly after this one, and it runs its
   * remedy too. Both have to: a string match alone cannot tell a sentence git accepts here from the
   * same sentence in the place git rejects it.
   */
  it("refuses an ordinary directory in the way, and names a remedy git accepts", async () => {
    const repositoryPath = await repository();
    const target = join(repositoryPath, ".awcli", "run", "worktrees", "triage", "main");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "someone-elses-work.txt"), "keep me\n", "utf8");
    const stack = new DisposalStack();

    const outcome = await acquireWorkspace(stack, {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("occupied");
    expect(outcome.message).toContain(target);
    // Never destructive: provisioning does not remove, force over, reset or clean anything.
    expect(await readFile(join(target, "someone-elses-work.txt"), "utf8")).toBe(
      "keep me\n",
    );
    expect(await branches(repositoryPath)).toEqual(["main"]);
    expect(stack.held).toEqual([]);

    // git rejects the command this message must not be advising, which is the whole finding.
    await expect(git(repositoryPath, "worktree", "remove", target)).rejects.toThrow(
      /is not a working tree/,
    );
    expect(outcome.message).not.toContain(`git worktree remove '${target}'`);
    // The unquoted form as well, because the remedies quote their paths now and an assertion against
    // the bare spelling would pass whatever the message said.
    expect(outcome.message).not.toContain(`git worktree remove ${target}`);
    // Moving or deleting it is still the remedy — it is now stated as the thing to do after looking
    // rather than as an instruction to follow blind, because "git has nothing registered there" is
    // also what a working copy another run is mid-way through checking out looks like.
    expect(outcome.message).toContain("before you move or delete it");
    expect(outcome.message).toContain("look at what is actually in there");

    // And what it does advise clears the way.
    await rm(target, { recursive: true, force: true });
    const second = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(second.ok).toBe(true);
  });

  /**
   * A registration forged out of a filename, which is the answer git hands over verbatim.
   *
   * `git worktree list --porcelain` prints paths raw — no quoting, no escaping — and a filename may
   * hold a newline. So a working copy registered at `<repo>/spoof\nworktree <target>\nx` emits two
   * extra lines that a line-based reader takes for records of its own, and awcli answered
   * "registered" for a target nothing was registered at. The remedy that follows from that answer is
   * `git worktree remove '<target>'`, which exits 128 on a path git has nothing at: the same defect
   * `worktreeRegistration` was written to prevent, reached from the other side. The actor is the one
   * this module's `NO_HOOKS` reasoning is built around — an agent that can run git in the shared dir
   * — and `-z` is the fix, because one record is then one attribute.
   */
  it("does not read a registration out of a worktree path that contains a newline", async () => {
    const repositoryPath = await repository();
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    // An ordinary directory in the way, so the refusal is `occupied` and the remedy turns on the
    // registration question.
    await mkdir(target, { recursive: true });
    // The forged record, registered as a real working copy at a path git will print back as it is.
    await git(
      repositoryPath,
      "worktree",
      "add",
      "-q",
      `${join(repositoryPath, "spoof")}\nworktree ${target}\nx`,
      "-b",
      "spoofed",
    );

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("occupied");
    // git refuses the command a forged "registered" would have named, which is the finding.
    await expect(git(repositoryPath, "worktree", "remove", target)).rejects.toThrow(
      /is not a working tree/,
    );
    expect(outcome.message).not.toContain(`git worktree remove '${target}'`);
    expect(outcome.message).toContain("look at what is actually in there");
  });

  /**
   * A working copy git *does* have registered, where the opposite remedy is the one that works.
   *
   * Every command the refusal names is run here, in the order it names them, ending in a run that
   * provisions — because the finding this test exists for is not a wording preference. A refusal
   * whose remedy git rejects leaves an operator with a run name they cannot use and no next step.
   */
  it("refuses a registered working copy, and names the removal that clears it", async () => {
    const repositoryPath = await repository();
    const first = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const target = first.workspace.dir;

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("occupied");
    // Single-quoted, because the operator is meant to paste this and the repository root is whatever
    // their disk says — `~/My Projects/repo` split on the space and git answered with a usage error.
    expect(outcome.message).toContain(`git worktree remove '${target}'`);
    // And no unlock in front of it, because this registration is not locked: the removal below runs
    // as printed, so a message asking them to unlock first would send them to a command that fails
    // with `error: '<path>' is not locked`.
    expect(outcome.message).not.toContain("git worktree unlock");
    // `-d` and not `-D`: this run's branch is the deliverable, and the operator reading this has
    // not been told whether anything is on it. `-d` refuses an unmerged branch and prints git's own
    // `-D` hint for insisting; `-D` throws the commits away with no second question. Verified on
    // git 2.55, and asserted in workspace-branches.test.ts against a branch that has work on it.
    expect(outcome.message).toContain("git branch -d awcli/triage/main");
    expect(outcome.message).not.toContain("git branch -D");
    // And the sentence says the delete refuses, rather than asserting flatly that it deletes: the
    // state this refusal is written for is a run of this name that already exists, whose branch may
    // well hold commits nothing else does — the one state `-d` exits 1 in.
    expect(outcome.message).toMatch(/refuses while the branch holds/);

    await git(repositoryPath, "worktree", "remove", target);
    await git(repositoryPath, "branch", "-d", "awcli/triage/main");
    const third = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(third.ok).toBe(true);
    // The registration was unlocked, which is the only state this arm may fire for: `git worktree
    // list` carried no `locked` attribute for it, and the discriminator says so.
    expect(outcome.detail).toEqual({
      kind: "occupied",
      occupancy: "found",
      registration: "registered",
    });
  });

  /**
   * A working copy another acquisition is checking out *right now*, which git registers from the
   * start of `git worktree add` and not the end.
   *
   * The arm above is where this used to land, and it is the one arm with no racing hedge on it: it
   * says to remove the working copy at that path and delete the branch. `git worktree add` writes
   * `.git/worktrees/<id>` and marks the entry `locked initializing` at the very start of its run and
   * releases the lock only when it exits zero — verified on git 2.55 by polling
   * `git worktree list --porcelain` through an add held open by a sleeping smudge filter. The
   * winner's sequence is `mkdir`, then `git branch` (a few milliseconds), then the add (the long
   * phase), so a loser whose `lstat` lands anywhere in that long phase discovers a `found` target and
   * asks about a registration that exists. It was then told to destroy a live run's working copy.
   *
   * Every command that arm names is also run here, because none of them works in this state: the
   * removal exits 128 on a locked working copy, `--force` exits 128 as well, and the branch delete
   * exits 1 while any working copy holds the ref. A message that names them is not merely impolite,
   * it is unusable — which is why this asserts what git does and not how the sentence is worded.
   *
   * Staged rather than raced, on this suite's precedent: a real registration, locked with git's own
   * reason, so the ordering under test is the one every machine gets.
   */
  it("refuses a working copy another run is still checking out, and names nothing to remove", async () => {
    const repositoryPath = await repository();
    const first = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const target = first.workspace.dir;
    await git(repositoryPath, "worktree", "lock", "--reason", "initializing", target);

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("occupied");
    // The answer a consumer reads, rather than the sentence: `found` alone is what the registered
    // arm fires for too, so the registration is the half that separates them.
    expect(outcome.detail).toEqual({
      kind: "occupied",
      occupancy: "found",
      registration: "initializing",
    });

    // Neither command that would take a live run's work away, and the quoted forms too — the
    // remedies quote their paths, so an assertion against only the bare spelling would pass whatever
    // the message said.
    expect(outcome.message).not.toContain(`git worktree remove '${target}'`);
    expect(outcome.message).not.toContain(`git worktree remove ${target}`);
    expect(outcome.message).not.toContain("git branch -d awcli/triage/main");
    expect(outcome.message).not.toContain("git branch -D");
    // And git rejects all three, which is why naming them would leave the operator with nothing.
    await expect(git(repositoryPath, "worktree", "remove", target)).rejects.toThrow(
      /cannot remove a locked working tree/,
    );
    await expect(
      git(repositoryPath, "worktree", "remove", "--force", target),
    ).rejects.toThrow(/cannot remove a locked working tree/);
    await expect(
      git(repositoryPath, "branch", "-d", "awcli/triage/main"),
    ).rejects.toThrow(/used by worktree at/);

    // What it says instead: wait, remove nothing, and watch the command that actually answers the
    // question — which the old wording told the operator not to trust.
    expect(outcome.message).toContain("Wait for it and remove nothing");
    expect(outcome.message).toContain("git worktree list");
    expect(outcome.message).toContain("locked initializing");

    // Nothing of the winner's moved: refusing is the whole of what the loser did.
    expect(await worktreeCount(repositoryPath)).toBe(2);
    expect(await branches(repositoryPath)).toEqual(["awcli/triage/main", "main"]);
  });

  /**
   * A working copy somebody locked deliberately, where the removal is right but not yet runnable.
   *
   * The third state `git worktree list` distinguishes, and the reason the `initializing` answer is
   * not simply "locked": an ordinary lock is an operator holding a working copy on purpose — a
   * removable drive, a long-running experiment — so the remedy is the registered arm's, with an
   * unlock in front of it and a sentence saying to look at what the lock is for. `git worktree
   * remove` exits 128 while the lock stands and so does `--force`, and `git worktree prune` will not
   * clear it either, so a message that named the removal alone named a command that refuses.
   * Measured on git 2.55, and run here in the order the refusal names.
   *
   * The recorded reason is quoted, which puts a string somebody else wrote into awcli's own
   * sentence: git prints a lock reason back raw under `-z`, newlines and control characters and all.
   * So it goes through `printable` like every other foreign value, and this asserts that rather than
   * assuming it.
   */
  it("refuses a locked working copy, quoting the reason and naming the unlock first", async () => {
    const repositoryPath = await repository();
    const first = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const target = first.workspace.dir;
    // An escape sequence and a right-to-left override, which are what a lock reason can carry into a
    // terminal: the first repaints it, the second reverses the rendering of the rest of the sentence.
    await git(
      repositoryPath,
      "worktree",
      "lock",
      "--reason",
      "\u001b[31mhands off\u202e",
      target,
    );

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("occupied");
    expect(outcome.detail).toEqual({
      kind: "occupied",
      occupancy: "found",
      registration: "locked",
    });
    // Recognisable, without the two characters that make a terminal lie.
    expect(outcome.message).toContain("?[31mhands off?");
    expect(outcome.message).not.toContain("\u001b");
    expect(outcome.message).not.toContain("\u202e");

    // The removal on its own is what the message must not have led with, and git says why.
    await expect(git(repositoryPath, "worktree", "remove", target)).rejects.toThrow(
      /cannot remove a locked working tree/,
    );

    // Then the sequence it does name, lifted out of the sentence and run by a shell so the quoting
    // is under test too, in the order the message gives them.
    const unlock = /"(git worktree unlock [^"]+)"/.exec(outcome.message)?.[1];
    const remove = /"(git worktree remove '[^"]+)"/.exec(outcome.message)?.[1];
    expect(unlock).toBeDefined();
    expect(remove).toBeDefined();
    await shell(repositoryPath, unlock ?? "");
    await shell(repositoryPath, remove ?? "");
    expect(await worktreeCount(repositoryPath)).toBe(1);
    // And the delete it names is the refusing one. This arm ran it a line below and asserted nothing
    // about the sentence, so `-D` could be restored here with all ten suites green — the class the
    // gate's "a refusal never names a command that discards commits" section exists for, on the arm
    // that section did not reach. `-D` force-deletes the branch the same message calls the
    // deliverable, and this refusal's own state is a run of this name whose commits are on it.
    expect(outcome.message).toContain("git branch -d awcli/triage/main");
    expect(outcome.message).not.toContain("git branch -D");
    await git(repositoryPath, "branch", "-d", "awcli/triage/main");
    const again = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(again.ok).toBe(true);
  });

  /**
   * A lock on somebody else's working copy, which says nothing about this target.
   *
   * `locked` is an *attribute of an entry* and cannot be recognised on its own — the record is the
   * bare word, or the word and a reason, with nothing in it naming which working copy it belongs to.
   * So the reset when an entry opens is the whole of the scoping, and this is what watches it: an
   * operator's own deliberately locked worktree is listed *before* this run's, and a reader that let
   * its attribute carry over would report the target locked and tell the operator to unlock a
   * registration that is not locked. `git worktree unlock` exits 1 on one of those.
   *
   * The *order* is what the test controls and git does not promise: it lists the main working tree
   * first and then whatever reading `.git/worktrees` gives it, which on this machine put this run's
   * `main` ahead of an entry whose id sorts before it. So the seam hands the parser git's own bytes
   * with the entries reordered — every record still exactly as git printed it, the locked one moved
   * in front of the target's — rather than a listing this test made up or an ordering it hoped for.
   *
   * The unrelated lock carries git's own `initializing` reason, so a reader that ignored the scoping
   * would land on the arm that says a run is provisioning here — the most confusing answer available
   * about a working copy the operator's own last run left behind.
   */
  it("does not attribute another working copy's lock to the target", async () => {
    const repositoryPath = await repository();
    // Somebody else's working copy, registered and locked.
    const elsewhere = join(repositoryPath, "their-tree");
    await git(repositoryPath, "worktree", "add", "-q", elsewhere, "-b", "theirs");
    await git(repositoryPath, "worktree", "lock", "--reason", "initializing", elsewhere);
    const first = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const target = first.workspace.dir;
    const isLocked = (entry: string): boolean =>
      /\0locked( |$)/.test(entry) || entry.startsWith("locked ");
    let reordered = false;
    const lockedFirst: GitRunner = async (args, cwd) => {
      const outcome = await systemGitRunner(args, cwd);
      if (
        !(args.includes("worktree") && args.includes("list")) ||
        outcome.kind !== "ran"
      ) {
        return outcome;
      }
      // git's own records, entry order ours: `-z` puts a NUL after every record, so a NUL pair is
      // the boundary between entries and splitting on it loses nothing.
      const entries = outcome.stdout.split("\0\0").filter((entry) => entry.length > 0);
      expect(entries.filter(isLocked)).toHaveLength(1);
      reordered = true;
      return {
        ...outcome,
        stdout: [...entries.filter(isLocked), ...entries.filter((e) => !isLocked(e))]
          .map((entry) => `${entry}\0\0`)
          .join(""),
      };
    };

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: lockedFirst,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("occupied");
    expect(reordered).toBe(true);
    // The target's own entry carries no lock, whatever the entry before it carried.
    expect(outcome.detail).toEqual({
      kind: "occupied",
      occupancy: "found",
      registration: "registered",
    });
    expect(outcome.message).not.toContain("git worktree unlock");
    expect(outcome.message).not.toContain("initializing");
    // And the remedy it does name runs, which is what the unlocked answer is for.
    expect(outcome.message).toContain(`git worktree remove '${target}'`);
    await git(repositoryPath, "worktree", "remove", target);
    expect(await worktreeCount(repositoryPath)).toBe(2);
    // The other worktree's lock is still theirs.
    await expect(git(repositoryPath, "worktree", "remove", elsewhere)).rejects.toThrow(
      /cannot remove a locked working tree/,
    );
  });

  /**
   * A symlink sitting at the target before awcli looks at all — the static half of the same hazard.
   *
   * `assertNoSymlinkedAncestors` deliberately stops at the target's parent, so the only thing standing
   * between a committed link here and `git worktree add` following it is that awcli refuses to
   * provision over *anything* at the target. That is a refusal rather than a throw because a link is
   * one of the things a previous run or an operator can legitimately have put there, and the answer
   * — leave it alone and say so — is the same either way.
   */
  it("refuses a symlink already at the target, and follows nothing", async () => {
    const repositoryPath = await repository();
    const elsewhere = await mkdtemp(join(tmpdir(), "awcli-workspace-elsewhere-"));
    track(elsewhere);
    const target = join(repositoryPath, ".awcli", "run", "worktrees", "triage", "main");
    await mkdir(dirname(target), { recursive: true });
    await symlink(elsewhere, target);

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("occupied");
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await branches(repositoryPath)).toEqual(["main"]);
    // Left exactly as it was: provisioning never removes what it finds, a link included.
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  });

  /**
   * A symlink planted at the target *after* awcli has looked at it.
   *
   * The early check cannot be the guarantee: between it and `git worktree add` sit `makeLayout`'s
   * four mkdirs and four lstats, the target's own mkdir, and a subprocess. There is no *recursive*
   * mkdir anywhere on that path any more, which is what this said — every one of the five is
   * non-recursive precisely so a link cannot be followed, and the paragraph below already credits
   * that. The window is opened deterministically here rather than raced for — the git seam is the
   * subprocess that sits inside it, so the runner plants the link on its way past, which is exactly
   * what another process doing it at that moment would look like.
   *
   * Without the non-recursive `mkdir` of the target, git follows the link and checks the tree out at
   * its destination, outside the repository, while the handle and the operator-facing description
   * both say it is inside. Reproduced on git 2.55 before this was written.
   */
  it("refuses a symlink planted at the target after the check, and follows nothing", async () => {
    const repositoryPath = await repository();
    const elsewhere = await mkdtemp(join(tmpdir(), "awcli-workspace-elsewhere-"));
    track(elsewhere);
    const target = join(repositoryPath, ".awcli", "run", "worktrees", "triage", "main");

    const planting: GitRunner = async (args, cwd) => {
      // The last git call before the add, and therefore the middle of the window.
      if (args[0] === "for-each-ref") {
        await mkdir(dirname(target), { recursive: true });
        await symlink(elsewhere, target);
      }
      return systemGitRunner(args, cwd);
    };

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: planting,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("occupied");
    // Nothing was checked out through the link, and no branch was cut for a working copy that would
    // have been outside the repository.
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await branches(repositoryPath)).toEqual(["main"]);
  });

  /**
   * A branch that appears between the collision check and the claim.
   *
   * The check cannot be the guarantee here any more than the target `lstat` can: a `mkdir` and a
   * subprocess sit between it and the claim. What closes the window is that `git branch <name> <sha>`
   * is a ref transaction — atomic, and it refuses a name that exists — so the branch is either
   * awcli's or somebody else's with nothing in between. What it must not do is arrive as the thrown
   * fault reserved for conditions awcli has no sentence for: this one has a sentence already written,
   * and an operator who reads `git branch exited 128` is told nothing they can act on. The window is
   * opened deterministically through the git seam rather than raced for.
   *
   * The planted branch surviving is the other half, and it is the half that rules out the remedy a
   * reviewer would reach for: `git branch -f` would claim the name whatever is there, and the run
   * would proceed on a branch whose commits it had just thrown away. Nothing here may move a ref that
   * is not awcli's.
   */
  it("refuses when the branch appears between the collision check and the add", async () => {
    const repositoryPath = await repository();
    let planted = false;
    const racing: GitRunner = async (args, cwd) => {
      const outcome = await systemGitRunner(args, cwd);
      // The last git call before the add, and therefore the middle of the window. Once only: the
      // second `for-each-ref` is awcli asking again after the add failed, and that one has to see
      // the repository as it now is.
      if (args[0] === "for-each-ref" && !planted) {
        planted = true;
        await git(repositoryPath, "branch", "awcli/triage/main");
      }
      return outcome;
    };

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: racing,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("branch-exists");
    expect(outcome.message).toContain("awcli/triage/main");
    // Somebody else's branch, still where they left it and still pointing where it pointed.
    expect(await branches(repositoryPath)).toEqual(["awcli/triage/main", "main"]);
    expect((await git(repositoryPath, "rev-parse", "awcli/triage/main")).trim()).toBe(
      (await git(repositoryPath, "rev-parse", "main")).trim(),
    );
    // And the empty directory awcli made for git goes back, exactly as it does on the thrown path.
    expect(
      existsSync(join(repositoryPath, ".awcli", "run", "worktrees", "triage", "main")),
    ).toBe(false);
  });

  /**
   * Two callers asking for one run and slot at the same moment.
   *
   * Nothing outside `acquireWorkspace` serialises this — it does not require the run lock, and
   * `SandboxOptions.name` lets a workflow name the same slot twice. So the loser has to come back as
   * a refusal the caller can read, not as a rejected promise: `occupied` is the sentence for a target
   * that is not free, and it is true of this one.
   */
  it("refuses the loser of two concurrent acquisitions rather than rejecting", async () => {
    const repositoryPath = await repository();
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);

    const settled = await Promise.allSettled(
      [0, 1].map(() =>
        acquireWorkspace(new DisposalStack(), {
          repositoryPath,
          runName: TRIAGE,
          choice: resolveWorkspaceChoice({}),
        }),
      ),
    );

    expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const outcomes = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.ok) continue;
      expect(outcome.kind).toBe("occupied");
      // And the loser is not told to delete the winner's working copy, which is what it said: "git
      // has no working copy registered there ... move it or delete it yourself, then run again",
      // about a directory that a second later holds another run's live agent.
      //
      // Asserted without naming which arm produced it, and that is the correction rather than
      // fussiness. The first version of this test asserted the `raced` wording, on the strength of
      // the loser's `mkdir` failing eight times out of eight here — and CI produced the other
      // ordering on the first attempt, where the winner's `mkdir` lands before the loser's `lstat`
      // and the loser never sees EEXIST at all. Three arms are now reachable from here rather than
      // two, and which one fires depends on where in its own sequence the winner is when the loser
      // asks git: `raced`, or `found` with the registration `initializing` while the add runs, or
      // `found` with nothing registered in the few milliseconds between the winner's `mkdir` and its
      // add. All three are hedged, and each has a deterministic test of its own above and in
      // workspace-fs-faults.test.ts — what has to hold *here* is only what holds on every one of
      // them: no instruction to move or delete what is there, and a wait before touching it.
      expect(outcome.message).not.toContain(
        "move it or delete it yourself, then run again",
      );
      expect(outcome.message).toMatch(/wait for (it|that run)/i);
      // The machine-readable half is there and says which discovery this was, so a caller deciding
      // whether a retry is worth making does not have to read the prose for it.
      const detail = outcome.detail;
      expect(detail?.kind).toBe("occupied");
      if (detail?.kind !== "occupied") continue;
      expect(["found", "raced"]).toContain(detail.occupancy);
      // And the invariant that ties the two together, which is the finding rather than a wording
      // preference: a removal is named only where git has — or may have — something at that path to
      // remove. The two answers a losing racer normally gets are `initializing`, while the winner's
      // add holds the entry locked, and `unregistered`, in the few milliseconds between the winner's
      // `mkdir` and its add; neither may produce an instruction to clear the path.
      if (outcome.message.includes(`git worktree remove '${target}'`)) {
        expect(["registered", "locked", "unknown"]).toContain(detail.registration);
      }
    }
    // One working copy, one branch: the loser provisioned nothing.
    expect(await branches(repositoryPath)).toEqual(["awcli/triage/main", "main"]);
  });

  /**
   * The cheapest and safest escape from an occupied target, which only the branch refusals offered.
   *
   * Both `collisionMessage` endings finish "Or run this under a different --name" and
   * `occupiedMessage` did not — on the one branch that instead leads with `git worktree remove` and
   * `git branch -d`, and whose `unregistered` arm offers "move it or delete it yourself" as the only
   * route. A different run name touches nothing that is already on disk; two sibling refusals with
   * the same root cause (this run and slot are taken) should not disagree about whether it exists.
   */
  it("offers a different run name as well as the removals, on every occupied arm", async () => {
    const repositoryPath = await repository();
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "someone-else.txt"), "not awcli's\n", "utf8");

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("occupied");
    expect(outcome.message).toContain("--name");
  });

  /**
   * The directory awcli made goes back when the git *runner* throws, not only when git exits
   * non-zero — staged as the shape where git never wrote anything, which is the only shape where
   * "the run and slot are usable again" is true.
   *
   * `run` throws for a git that has gone missing and for a `cwd` that has; the raw runner throws for
   * the 120s timeout, for an answer past `maxBuffer`, and for a child killed by a signal — the OOM
   * case `git-process.ts` documents at length. The `rmdir` sat inside `if (added.code !== 0)`, so on
   * any of those `mkdir(target)` had already claimed the path and nothing put it back: the *next*
   * invocation of this run and slot was refused `occupied` over awcli's own empty leftover, which is
   * the self-inflicted window the comment there says it closes.
   *
   * What this test may claim is bounded to the shape it stages, and that bound is the correction: the
   * runner here rejects *without git having run at all*, so the target is still the empty directory
   * awcli made, nothing is registered, and both halves of the tidying succeed. Against the three
   * shapes named above git has run, and none of the three assertions below holds — the two sibling
   * tests are where those live: the timeout that left a partial checkout, directly after this, and
   * the signal that left all three leftovers, after that. Read as a general guarantee, this test was
   * green over something the code does not deliver.
   */
  it("puts back what it made when the runner throws before git has run", async () => {
    const repositoryPath = await repository();
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    const collapsing: GitRunner = async (args, cwd) => {
      if (isWorktreeAdd(args)) throw new Error("git did not finish within 120000ms");
      return systemGitRunner(args, cwd);
    };

    const thrown = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: collapsing,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toMatch(/did not finish/);

    expect(existsSync(target)).toBe(false);
    expect(await branches(repositoryPath)).toEqual(["main"]);

    // And the fault invents no leftovers to go with it. Both halves of the tidying succeeded here,
    // and a successful `git branch -D` is proof that no working copy held the ref — so there is
    // nothing at that path and nothing registered for it, and a sentence naming an unlock and a
    // forced removal would send the operator hunting for something that is not there.
    expect(message).not.toContain("git worktree unlock");
    expect(message).not.toContain("still there");

    // And the run and slot are usable again, which is the whole of what the leftovers cost.
    const again = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(again.ok).toBe(true);
  });

  /**
   * The timeout shape: git ran, wrote part of a tree, and was killed with SIGTERM.
   *
   * `execFile`'s own timeout sends SIGTERM, and git's cleanup handler *does* run for that one — it
   * removes its admin directory, so nothing stays registered. What it does not do is take back the
   * files it had already checked out, so the target is not empty and `rmdir` fails with ENOTEMPTY.
   * The branch delete then succeeds, because with the registration gone nothing holds the ref.
   *
   * That is the middle arm of the residual, and it had no test: the suite staged only the shape where
   * git never ran, so `rmdir` always succeeded and the fault always came out bare. Here the fault has
   * to say that the directory did not go back and the branch did — and it must not claim the reverse,
   * which is what a discarded exit status produces.
   */
  it("names the partial checkout a timed-out add left, and the branch it did put back", async () => {
    const repositoryPath = await repository();
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    const timedOut: GitRunner = async (args, cwd) => {
      if (!isWorktreeAdd(args)) return systemGitRunner(args, cwd);
      // What SIGTERM leaves: files under the target, and no registration, because git tidied its own
      // admin directory on the way out.
      await writeFile(join(target, "half-checked-out.txt"), "partial\n", "utf8");
      throw new Error("git worktree add did not finish within 120000ms");
    };

    const thrown = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: timedOut,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("did not finish");
    // The two halves, each the way round it actually happened.
    expect(message).toContain("deleted the branch it had cut");
    expect(message).toContain(target);
    expect(await branches(repositoryPath)).toEqual(["main"]);
    expect(existsSync(join(target, "half-checked-out.txt"))).toBe(true);
    // Nothing is registered, so the operator is not sent to unlock something that is not there —
    // and the run and slot are *not* usable, which is the guarantee this shape breaks.
    expect(await worktreeCount(repositoryPath)).toBe(1);
    const again = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.kind).toBe("occupied");
  });

  /**
   * The state a `git worktree add` killed by a signal actually leaves, and what awcli then says.
   *
   * The OOM killer's own case, which the handler around the add was documented as closing and does
   * not: SIGKILL means git's cleanup handler never runs, so it leaves three things rather than the
   * one empty directory the handler was written for — a part-checked-out target, a registration git
   * still holds and has marked `locked initializing`, and the branch that registration holds.
   * Measured on git 2.55 by SIGKILLing an add mid-checkout, and staged here as the same end state
   * with a real add and a real lock, because every claim the fault makes is a claim about what git
   * then refuses.
   *
   * `undoOwnBranch` clears none of it — `rmdir` exits ENOTEMPTY and `git branch -D` exits 1 naming
   * the worktree that holds the ref — and both statuses used to be discarded, so what awcli threw
   * was the raw runner line: it named no leftover and its silence read as a successful tidy-up. The
   * next invocation of this run and slot was then refused over each leftover in turn, with every
   * command awcli names anywhere failing: the removal exits 128 on a locked tree, `--force` too, and
   * `git worktree prune` leaves the entry listed. So the commands this fault names are a different
   * set from every other message in the module, and they are run here in the order it gives them.
   */
  it("names what a killed add left behind, and the commands that clear it", async () => {
    const repositoryPath = await repository();
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    const killed: GitRunner = async (args, cwd) => {
      if (!isWorktreeAdd(args)) return systemGitRunner(args, cwd);
      // The add runs and registers the working copy, the lock stands as git leaves it during a
      // checkout, and then the process dies without releasing it.
      await systemGitRunner(args, cwd);
      await git(repositoryPath, "worktree", "lock", "--reason", "initializing", target);
      throw new Error(`git worktree add was killed by SIGKILL in ${cwd}`);
    };

    const thrown = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: killed,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    const message = thrown instanceof Error ? thrown.message : "";
    // git's own line survives, because it is the only thing that says what happened.
    expect(message).toContain("killed by SIGKILL");
    // And the three leftovers are named rather than left for the next run to discover.
    expect(message).toContain(target);
    expect(message).toContain("awcli/triage/main");
    expect(message).toContain("git worktree list");
    // Not a claim that awcli put anything back: it put back neither.
    expect(message).toContain("could not put back either");
    expect(existsSync(target)).toBe(true);
    expect(await branches(repositoryPath)).toEqual(["awcli/triage/main", "main"]);

    // The commands every other refusal in this module names, and what git does with them here.
    await expect(git(repositoryPath, "worktree", "remove", target)).rejects.toThrow(
      /cannot remove a locked working tree/,
    );
    await expect(
      git(repositoryPath, "worktree", "remove", "--force", target),
    ).rejects.toThrow(/cannot remove a locked working tree/);
    await expect(
      git(repositoryPath, "branch", "-d", "awcli/triage/main"),
    ).rejects.toThrow(/used by worktree at/);
    // `prune` is the command the sibling refusals offer for a stale registration, and it is the
    // reason the unlock has to be named here at all: it leaves a locked entry listed, so it cannot
    // be the whole remedy on this path.
    await git(repositoryPath, "worktree", "prune");
    expect(await worktreeCount(repositoryPath)).toBe(2);

    // Then the sequence it does name, lifted out of the sentence and run by a shell in that order.
    const unlock = /"(git worktree unlock [^"]+)"/.exec(message)?.[1];
    const remove = /"(git worktree remove '[^"]+)"/.exec(message)?.[1];
    expect(unlock).toBeDefined();
    expect(remove).toBeDefined();
    await shell(repositoryPath, unlock ?? "");
    await shell(repositoryPath, remove ?? "");
    // The delete the residual names, before it is run: the same unwatched-literal hole as the locked
    // refusal above, on the one message in the module that is a *fault* rather than a refusal — and
    // the state it is written for is a killed add, whose branch may already carry an agent's commits.
    expect(message).toContain("git branch -d awcli/triage/main");
    expect(message).not.toContain("git branch -D");
    await git(repositoryPath, "branch", "-d", "awcli/triage/main");
    expect(await worktreeCount(repositoryPath)).toBe(1);

    // And the run and slot are usable again, which is the whole of what the advice is for.
    const again = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(again.ok).toBe(true);
  });
});
