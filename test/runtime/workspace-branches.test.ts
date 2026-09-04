import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DisposalStack } from "../../src/runtime/disposal.js";
import { DEFAULT_SLOT, worktreePath } from "../../src/runtime/run-identity.js";
import { systemGitRunner, type GitRunner } from "../../src/runtime/git-process.js";
import { acquireWorkspace, resolveWorkspaceChoice } from "../../src/runtime/workspace.js";
import { PRINTABLE_LIMIT } from "../../src/runtime/printable.js";
import {
  git,
  repository,
  repositoryWithASpaceInItsPath,
  repositoryWithAnUnshowablePath,
  isWorktreeAdd,
  branches,
  shell,
  worktreeCount,
  runName,
  TRIAGE,
} from "./workspace-support.js";

/**
 * A branch already in the way of the one this run and slot derive.
 */
describe("what provisioning refuses rather than does: a branch in the way", () => {
  /**
   * A ref that collides only once case is folded.
   *
   * git resolves loose refs through the filesystem, which ignores case on the APFS and NTFS
   * defaults, so an operator branch differing from awcli's namespace only in case collides in git
   * while an exact string comparison sees nothing. `run-identity.ts` already reasons about that
   * property for awcli's *own* names; this applies the same lens to refs read out of the operator's
   * repository. Folding is a superset of the exact comparison and awcli's own names cannot vary in
   * case, so the only thing it can add is a refusal where there would have been a fault.
   *
   * The refusal is asserted rather than the fault, because what git does next differs by filesystem:
   * on a case-insensitive one the add fails with `cannot lock ref`, and on a case-sensitive one it
   * succeeds and leaves two branches a later checkout on macOS cannot tell apart.
   */
  it("refuses a namespace branch that collides only when case is folded", async () => {
    const repositoryPath = await repository();
    await git(repositoryPath, "branch", "awcli/Triage");

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("branch-exists");
    // Named as the operator spelled it: it is their branch, and they have to find it.
    expect(outcome.message).toContain("awcli/Triage");
    // `awcli/<run>` blocks this run and no other, so a different --name is a remedy — which is the
    // difference `detail` carries out to a caller instead of leaving it to be read off the prose.
    expect(outcome.detail).toEqual({ kind: "branch-exists", collision: "prefix" });
    expect(await branches(repositoryPath)).toEqual(["awcli/Triage", "main"]);
  });

  /**
   * The same fold, one segment further up — the case the fold could not reach.
   *
   * `branchCollision` folds case, but the refs it folds came from
   * `for-each-ref refs/heads/awcli`, and git matches that pattern *case-sensitively*: a branch
   * called `AWCLI` is simply not in the list, so there is nothing for the fold to fold against and
   * the second look after a failed add asks the same narrow question again. What an operator on
   * APFS then gets is `git worktree add exited 128` and no remedy — verbatim the outcome the
   * folding exists to prevent. So the question is asked of `refs/heads`, and the namespace filter
   * is the part that folds.
   */
  it("refuses a namespace branch that differs from awcli's own only in case", async () => {
    const repositoryPath = await repository();
    await git(repositoryPath, "branch", "AWCLI");

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("branch-exists");
    // Named as the operator spelled it, and named as the collision it is rather than as git's
    // `cannot lock ref`.
    expect(outcome.message).toContain("AWCLI");
    // And *not* offered a different --name, because a ref at the namespace root blocks every branch
    // under `awcli/` whatever the run is called. See the sibling test below for the split.
    //
    // The one collision shape with no remedy in a different run name, and the only one a consumer
    // has to treat differently — which is the whole reason `detail` carries it.
    expect(outcome.detail).toEqual({ kind: "branch-exists", collision: "namespace" });
    expect(await branches(repositoryPath)).toEqual(["AWCLI", "main"]);
  });

  /**
   * An unrelated branch is not a collision, which is what the widened query has to stay honest
   * about: asking `refs/heads` for everything and then filtering loosely would refuse every
   * repository that has any branch at all.
   */
  it("provisions past branches that have nothing to do with awcli's namespace", async () => {
    const repositoryPath = await repository();
    for (const unrelated of ["feature/awcli-adjacent", "awclish", "main-2"]) {
      await git(repositoryPath, "branch", unrelated);
    }

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(true);
  });

  /**
   * The ordinary case — a branch an earlier run of this name and slot left behind (BR-036).
   *
   * Asserted as what the *check before the add* buys, not only as the refusal that comes out: `-b`
   * refuses an existing branch too, and the re-check after a failed add turns that into the same
   * refusal, so the message alone no longer says whether awcli asked first. What asking first buys
   * is that nothing is attempted and nothing is created — no doomed subprocess, no directory made
   * and removed in the operator's repository — which is what the recorded calls below hold it to.
   */
  it("refuses when the branch it would cut is already there, without attempting the add", async () => {
    const repositoryPath = await repository();
    await git(repositoryPath, "branch", "awcli/triage/main");
    const before = (await git(repositoryPath, "rev-parse", "awcli/triage/main")).trim();
    const stack = new DisposalStack();
    const asked: string[][] = [];
    const recording: GitRunner = async (args, cwd) => {
      asked.push([...args]);
      return systemGitRunner(args, cwd);
    };

    const outcome = await acquireWorkspace(stack, {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: recording,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("branch-exists");
    // Decided from the collision query, before anything was tried or made.
    expect(asked.filter(isWorktreeAdd)).toEqual([]);
    expect(existsSync(join(repositoryPath, ".awcli", "run", "worktrees"))).toBe(false);
    expect(outcome.message).toContain("awcli/triage/main");
    // The shape a caller acts on: this run's own branch, which AWCLI-14 reattaches to and which the
    // other three shapes are not. Read from the field rather than from the sentence.
    expect(outcome.detail).toEqual({ kind: "branch-exists", collision: "same" });
    expect((await git(repositoryPath, "rev-parse", "awcli/triage/main")).trim()).toBe(
      before,
    );
    expect(stack.held).toEqual([]);

    // The remedy fits what is there, which for this scenario is a branch no working copy holds.
    // git rejects `git worktree remove` on a path with nothing registered at it — so advising it
    // "first", as the message did unconditionally, reads as blocking the one command that works.
    // Asserted against git rather than as a string, because a string match cannot tell a sentence
    // git accepts from the same sentence where git rejects it.
    await expect(
      git(
        repositoryPath,
        "worktree",
        "remove",
        worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT),
      ),
    ).rejects.toThrow(/is not a working tree/);
    expect(outcome.message).not.toContain("git worktree remove");
    expect(outcome.message).toContain("git branch -d awcli/triage/main");

    // The second escape, which is the one that touches nothing already on disk: the same run under a
    // different name derives a different branch and a different directory, so it needs no delete at
    // all. Asserted here because nothing did — the sentence offering it could be dropped from this
    // refusal with every suite green, and the gate mutation that was supposed to watch it had
    // drifted onto the *namespace* refusal's copy of the same clause (see the note in
    // `verify-workspace-gate.sh`). Run rather than string-matched, for this file's usual reason: an
    // offer of a remedy is only worth making if taking it works.
    expect(outcome.message).toContain("--name");
    const elsewhere = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: runName("nightly"),
      choice: resolveWorkspaceChoice({}),
    });
    expect(elsewhere.ok).toBe(true);
    if (elsewhere.ok) {
      expect(elsewhere.workspace.branch).toBe("awcli/nightly/main");
      // And the branch this run was refused over is untouched by the run that got past it.
      expect((await git(repositoryPath, "rev-parse", "awcli/triage/main")).trim()).toBe(
        before,
      );
    }

    // And what it does advise clears the way, run verbatim out of the message.
    await git(repositoryPath, "branch", "-d", "awcli/triage/main");
    const second = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(second.ok).toBe(true);
  });

  /**
   * The sequence an operator actually walks into, end to end.
   *
   * Release is a no-op and collection is AWCLI-22's, so today the only way to clear a working copy is
   * by hand — and the obvious way, deleting the directory, leaves git's registration for it in
   * `.git/worktrees/`. That registration holds the branch: the next run of the same name and slot is
   * refused for the branch, and a branch delete on it fails naming a path that is no longer there.
   * The refusal has to hand them the command that gets them out of it, so this asserts against git
   * itself rather than against the wording alone.
   */
  it("names a remedy git accepts when a deleted working copy still holds the branch", async () => {
    const repositoryPath = await repository();
    const first = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const target = first.workspace.dir;
    // The operator tidies up the way anyone would.
    await rm(target, { recursive: true, force: true });

    const second = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.kind).toBe("branch-exists");

    // Deleting the branch is what they would try, and git refuses: the registration still holds it.
    // git asks that question ahead of merged-ness, so this is the same refusal for `-d` and `-D`.
    await expect(
      git(repositoryPath, "branch", "-d", "awcli/triage/main"),
    ).rejects.toThrow(/used by worktree/);

    // The command the refusal names does work, on a directory that has already gone — and then the
    // branch can go too. Run verbatim out of the message, so wording that drifts from git's own
    // vocabulary fails here rather than in someone's terminal.
    expect(second.message).toContain(`git worktree remove '${target}'`);
    // And the delete it names after that removal refuses rather than discards. Named rather than
    // pointed at by direction, because the direction was wrong and a reader following it found
    // nothing: `advises a branch deletion that refuses rather than one that destroys the commits`,
    // below, is what runs `-d` against a branch carrying an agent's commit. Nothing above this test
    // does — every earlier one cuts the branch at HEAD, and the one that deletes it with `-d`
    // succeeds precisely because it is merged.
    expect(second.message).toContain("git branch -d awcli/triage/main");
    expect(second.message).not.toContain("git branch -D");
    expect(second.message).toMatch(/refuses while the branch holds/);
    // And no unlock in front of the removal: this registration is not locked, the removal below runs
    // as printed, and `git worktree unlock` on an unlocked registration exits 1. The locked variant
    // — which is what this module's own killed add leaves behind — is the test after this one.
    expect(second.message).not.toContain("git worktree unlock");
    await git(repositoryPath, "worktree", "remove", target);
    await git(repositoryPath, "branch", "-d", "awcli/triage/main");
    expect(await branches(repositoryPath)).toEqual(["main"]);
  });

  /**
   * The same sequence when the registration holding the branch is *locked*, where it stops one
   * command short.
   *
   * This is the leftover this module's own failed-add path can produce, met one run later: a
   * `git worktree add` killed part-way leaves the registration marked `locked initializing`, and
   * whoever tidied up deleted the directory. The registration goes on holding the branch, so the
   * refusal is `branch-exists` and the sibling arm's advice is exactly right except that it does not
   * run — `git worktree remove` exits 128 on a locked registration, `--force` exits 128 too, and
   * `git worktree prune` leaves the entry listed even with its directory gone. All measured on git
   * 2.55, and all three run here, because the arm above names `prune` as the thing that clears every
   * stale registration at once and that claim is true only of the unlocked ones.
   */
  it("names the unlock when a locked registration is what still holds the branch", async () => {
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
    await rm(target, { recursive: true, force: true });

    const second = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.kind).toBe("branch-exists");
    expect(second.detail).toEqual({ kind: "branch-exists", collision: "same" });

    // What the operator would try first, and what git says to each.
    await expect(
      git(repositoryPath, "branch", "-d", "awcli/triage/main"),
    ).rejects.toThrow(/used by worktree/);
    await expect(git(repositoryPath, "worktree", "remove", target)).rejects.toThrow(
      /cannot remove a locked working tree/,
    );
    await git(repositoryPath, "worktree", "prune");
    expect(await worktreeCount(repositoryPath)).toBe(2);

    // So the refusal names the unlock in front of the removal, and says which lock it is looking at
    // — this one is git's own word for an add that never finished, not an operator's hold.
    expect(second.message).toContain('locked with the reason "initializing"');
    expect(second.message).toContain(`git worktree unlock '${target}'`);
    expect(second.message).toContain("git branch -d awcli/triage/main");
    expect(second.message).not.toContain("git branch -D");

    // Run verbatim out of the message, in the order it gives them, through a shell.
    const unlock = /"(git worktree unlock [^"]+)"/.exec(second.message)?.[1];
    const remove = /"(git worktree remove '[^"]+)"/.exec(second.message)?.[1];
    expect(unlock).toBeDefined();
    expect(remove).toBeDefined();
    await shell(repositoryPath, unlock ?? "");
    await shell(repositoryPath, remove ?? "");
    await git(repositoryPath, "branch", "-d", "awcli/triage/main");
    expect(await branches(repositoryPath)).toEqual(["main"]);
    const third = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(third.ok).toBe(true);
  });

  /**
   * The same sequence on the branch it is actually written for, which does not clear the run name.
   *
   * Both tests that run the two-step remedy verbatim use a branch nothing has committed to, where
   * `-d` and `-D` behave identically — so the swap from one to the other went in under a green suite
   * that could not tell them apart. The state the refusal exists for is the other one: a finished run
   * left the branch, and the commits on it are what this module calls the deliverable. Run verbatim
   * there, the sequence clears the working copy and then stops, because `-d` refuses an unmerged
   * branch, and the run name stays unusable until the operator insists with the form git itself
   * prints. That is the intended outcome rather than a gap — awcli must not be the thing that
   * discards the commits — so it is recorded here, against git, in the order an operator meets it.
   */
  it("says so when the advised sequence stops at a branch that carries the run's work", async () => {
    const repositoryPath = await repository();
    const first = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const target = first.workspace.dir;
    // The agent's work, and then the operator tidies the directory away the way anyone would —
    // leaving git's registration, which is what makes this the `registered` arm.
    await git(target, "commit", "--allow-empty", "-qm", "the agent's work");
    const delivered = (
      await git(repositoryPath, "rev-parse", "awcli/triage/main")
    ).trim();
    await rm(target, { recursive: true, force: true });

    const second = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.kind).toBe("branch-exists");
    expect(second.message).toContain(`git worktree remove '${target}'`);
    expect(second.message).toContain("git branch -d awcli/triage/main");
    expect(second.message).not.toContain("git branch -D");
    // The sentence says the delete refuses and why, which is the whole of what the operator needs
    // for the step that is about to fail on them.
    expect(second.message).toMatch(/refuses while the branch holds/);

    // Step one works, on a directory that has already gone.
    await git(repositoryPath, "worktree", "remove", target);
    // Step two refuses, and the commits are still there afterwards.
    await expect(
      git(repositoryPath, "branch", "-d", "awcli/triage/main"),
    ).rejects.toThrow(/not fully merged/);
    expect((await git(repositoryPath, "rev-parse", "awcli/triage/main")).trim()).toBe(
      delivered,
    );
    // So the run name is still refused: the sequence is not a recovery for this state, and nothing
    // in awcli pretends otherwise.
    const third = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.kind).toBe("branch-exists");
  });

  /**
   * The branch remedy refusing rather than destroying, on a branch that has work on it.
   *
   * This is the state a finished run leaves: the working copy cleared (by hand today — release is a
   * no-op and collection is AWCLI-22's) and the branch holding the commits, which this module's own
   * docblock calls the deliverable. The next invocation of the same name is refused for the branch
   * and handed a way to delete it — so which flag that sentence names decides whether an operator
   * following awcli's advice loses an agent's work.
   *
   * `-D` is unconditional: it took the commits with no second question, unrecoverably as far as
   * anyone reading a refusal is concerned. `-d` refuses an unmerged branch and prints git's own
   * `-D` hint, so the operator who does mean it is one paste away and the operator who does not is
   * stopped. Reproduced on git 2.55 both ways before this was written. Run verbatim out of the
   * message, because the point is what happens in their terminal, not the wording.
   */
  it("advises a branch deletion that refuses rather than one that destroys the commits", async () => {
    const repositoryPath = await repository();
    const first = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The agent's work, which is the whole reason a run has a branch of its own.
    await git(first.workspace.dir, "commit", "--allow-empty", "-qm", "the agent's work");
    const delivered = (
      await git(repositoryPath, "rev-parse", "awcli/triage/main")
    ).trim();
    // The operator clears the working copy, properly — registration and all.
    await git(repositoryPath, "worktree", "remove", first.workspace.dir);

    const second = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.kind).toBe("branch-exists");
    expect(second.message).toContain("git branch -d awcli/triage/main");
    expect(second.message).not.toContain("git branch -D");
    // The refusal below is the ordinary case, not the exotic one, so the sentence has to name it:
    // the message asserted flatly that the command "deletes it" and accounted only for a working
    // copy holding the branch — which `git worktree list` answers and this state is not.
    expect(second.message).toMatch(/refuses while the branch holds/);

    // git refuses, tells them why, and the commit is still there afterwards.
    await expect(
      git(repositoryPath, "branch", "-d", "awcli/triage/main"),
    ).rejects.toThrow(/not fully merged/);
    expect((await git(repositoryPath, "rev-parse", "awcli/triage/main")).trim()).toBe(
      delivered,
    );
  });

  /**
   * The branch already there while git cannot say what holds it.
   *
   * `worktreeRegistration` has three answers and the third is the honest one: `git worktree list
   * --porcelain` is asked through the *raw* runner, which throws for a timeout and for an answer
   * larger than awcli reads, so "awcli could not ask" is a state the message has to have wording for.
   * Both confident arms had a test and a gate mutation; this one had neither, and the `-D` that the
   * whole class was moved off could be put back on it with the suite green. It is the same gap the
   * occupied path closed one refusal earlier (workspace-preflight.test.ts) — a run whose git call
   * cannot be answered still gets a remedy, and the remedy still refuses rather than discards.
   */
  it("still names a branch delete that refuses when git could not say what holds the branch", async () => {
    const repositoryPath = await repository();
    await git(repositoryPath, "branch", "awcli/triage/main");
    const stalling: GitRunner = async (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "list") {
        throw new Error(
          "git worktree list --porcelain did not finish within 120000ms in " + cwd,
        );
      }
      return systemGitRunner(args, cwd);
    };

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: stalling,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("branch-exists");
    // Both remedies named and neither claimed, and it says which of the two it could not tell.
    expect(outcome.message).toContain("git branch -d awcli/triage/main");
    expect(outcome.message).not.toContain("git branch -D");
    expect(outcome.message).toContain("git worktree remove");
    expect(outcome.message).toContain("could not ask git");
    // The delete refuses rather than discards, said here as on the two arms git could answer for.
    expect(outcome.message).toMatch(/refuses while the branch holds/);
  });

  /**
   * The losing side of two acquisitions of one run and slot, discovered at the *branch* site.
   *
   * `occupiedMessage` learned this lesson and `collisionMessage` did not: a loser reaches whichever
   * site the scheduling gives it. The window is not something the round-3 split created — `-b`
   * published the ref before it validated the target, so the winner's branch was visible for the
   * whole of its checkout under the combined form too; the split adds the gap between two processes
   * at the front of it. Either way the loser's collision query routinely sees a branch that a live
   * run cut a moment ago, and the remedy it was handed was `git worktree remove '<the winner's
   * working copy>'` followed by a delete of the winner's branch, with the confident wording of a
   * settled world.
   *
   * The evidence that tells the two apart is awcli's own `lstat`: the loser reached this site
   * *because* nothing was at the target when it looked, and a winner whose branch exists has already
   * created that directory — `mkdir` precedes the cut. So something being there now, when the
   * message is built, is another writer working right now, exactly as EEXIST from `mkdir` is on the
   * occupied path. Staged rather than raced, on this suite's own precedent: the winner's `mkdir` and
   * registration are made to land inside the loser's window, at the collision query, so the ordering
   * this test asserts about is the ordering it gets on every machine.
   */
  it("does not send a working copy that is being provisioned right now to git worktree remove", async () => {
    const repositoryPath = await repository();
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    // The winner has cut its branch; its checkout has not landed yet.
    await git(repositoryPath, "branch", "awcli/triage/main");
    let arrived = false;
    const winnerArrives: GitRunner = async (args, cwd) => {
      // The rest of the winner's provisioning, inside the loser's window: after the `lstat` that
      // found the path free, before the loser asks what is in the way.
      if (!arrived && args.includes("for-each-ref")) {
        arrived = true;
        await git(repositoryPath, "worktree", "add", target, "awcli/triage/main");
      }
      return systemGitRunner(args, cwd);
    };

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: winnerArrives,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("branch-exists");
    expect(arrived).toBe(true);
    // Neither of the two commands that would take the winner's working copy or its branch away.
    expect(outcome.message).not.toContain("git worktree remove");
    expect(outcome.message).not.toContain("git branch -d");
    expect(outcome.message).not.toContain("git branch -D");
    // And it says what it actually knows: something arrived under it while it was looking.
    expect(outcome.message).toContain("free when awcli looked");
    expect(outcome.message).toContain("Wait");
    // The winner is untouched — refusing is the whole of what the loser did.
    expect(existsSync(join(target, ".git"))).toBe(true);
    expect(await branches(repositoryPath)).toEqual(["awcli/triage/main", "main"]);
  });

  /**
   * git stores a branch as a file under `refs/heads/`, so a branch and a directory of branches
   * cannot share a name. An operator branch called `awcli` or `awcli/triage` therefore makes every
   * branch awcli would cut uncreatable — with `fatal: cannot lock ref`, which is not a next step.
   */
  it.each([["awcli"], ["awcli/triage"]])(
    "refuses when the operator's own branch %j blocks the namespace",
    async (blocking) => {
      const repositoryPath = await repository();
      await git(repositoryPath, "branch", blocking);

      const outcome = await acquireWorkspace(new DisposalStack(), {
        repositoryPath,
        runName: TRIAGE,
        choice: resolveWorkspaceChoice({}),
      });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.kind).toBe("branch-exists");
      expect(outcome.message).toContain(blocking);
      // A next step, rather than git's own "cannot lock ref" — and only the next step that works.
      // `refs/heads/awcli` blocks `awcli/<anything>`, so a different run name changes nothing and
      // that half of the advice is withheld; `refs/heads/awcli/triage` blocks only the `triage` run,
      // so there it is offered. Verified against git 2.55 before this was split: with `awcli`
      // present, `worktree add -b awcli/other/main` fails exactly as `awcli/triage/main` did.
      expect(outcome.message).toContain("rename or delete it");
      expect(outcome.message.includes("--name")).toBe(blocking !== "awcli");
      expect(await branches(repositoryPath)).toEqual([blocking, "main"].sort());
    },
  );

  /**
   * A colliding branch name long enough that `printable`'s own default would truncate it.
   *
   * The three non-`same` arms interpolate the ref into "so rename or delete it", and `short()` was
   * calling `printable` with no limit — `PRINTABLE_LIMIT`, 64, which is sized for a hostname. A run
   * name may be 64 characters (`MAX_NAME_LENGTH`), so the `prefix` collision ref `awcli/<run>`
   * passes 64 at a 59-character run name and the operator was handed a branch name with an ellipsis
   * in the middle of it, followed by an instruction to act on it. It is the defect `shellPath` and
   * `COMMAND_PATH_LIMIT` were introduced to fix for paths, one field over.
   *
   * The name is asserted against git rather than against the sentence: the ref lifted out of the
   * message has to be one git resolves. A truncated one does not, which is the whole finding.
   */
  it("names a long colliding branch in full, so the ref it prints is one git resolves", async () => {
    const repositoryPath = await repository();
    const longRun = runName(`triage-${"n".repeat(52)}`);
    expect(longRun).toHaveLength(59);
    const blocking = `awcli/${longRun}`;
    expect(blocking.length).toBeGreaterThan(PRINTABLE_LIMIT);
    await git(repositoryPath, "branch", blocking);

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: longRun,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("branch-exists");
    expect(outcome.detail).toEqual({ kind: "branch-exists", collision: "prefix" });
    // Lifted out of the sentence the way an operator would read it off, and resolved by git.
    const named = /the branch (\S+) already exists/.exec(outcome.message)?.[1];
    expect(named).toBe(blocking);
    expect(
      (await git(repositoryPath, "rev-parse", "--verify", `refs/heads/${named}`)).trim(),
    ).toBe((await git(repositoryPath, "rev-parse", "HEAD")).trim());
  });

  it("refuses when a branch beneath the one it would cut blocks it", async () => {
    const repositoryPath = await repository();
    await git(repositoryPath, "branch", "awcli/triage/main/deeper");

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("branch-exists");
    expect(outcome.message).toContain("awcli/triage/main/deeper");
    expect(outcome.detail).toEqual({ kind: "branch-exists", collision: "below" });
  });

  /**
   * A colliding ref is a name out of the operator's repository, and it reaches the terminal.
   *
   * `branchCollision`'s `short()` wraps it in `printable`, and nothing watched that — while the
   * comment justifying the *live checkout* branch being sanitised points at this function as the case
   * already handled ("the refusal path already sanitises refs read out of the same repository"). The
   * half that was cited as settled had neither a test nor a gate mutation; the half doing the citing
   * had both. A bidirectional override reverses the rendering of everything after it, so the operator
   * reads a line awcli did not emit.
   */
  it("does not carry a bidi override out of a colliding branch name into what it prints", async () => {
    const repositoryPath = await repository();
    const hostile = "awcli/triage/main/\u202ednammoc-suoicilam";
    await git(repositoryPath, "branch", hostile);

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("branch-exists");
    expect(outcome.message).not.toContain("\u202e");
    // Still recognisable: what is removed is what a terminal renders differently, not the name.
    expect(outcome.message).toContain("dnammoc-suoicilam");
  });

  /**
   * The remedy is run, rather than string-matched, from a repository whose path contains a space.
   *
   * Every `git worktree remove ${target}` in a refusal was unquoted, and the repository root is
   * whatever the operator's disk says — `~/My Projects/repo`, `~/Library/Application Support/...`.
   * Copied out of the message and pasted into a shell the command split on the space and git answered
   * with a usage error, so the refusal named a remedy that does not run. That is the same class as
   * naming the wrong command, one layer down, and the only way to hold it to the code is to execute
   * what the message printed.
   */
  it("prints an occupied remedy that runs from a repository path with a space in it", async () => {
    const repositoryPath = await repositoryWithASpaceInItsPath();
    expect(repositoryPath).toContain(" ");
    const first = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("occupied");

    // Lifted out of the sentence exactly as an operator would copy it, and run by a shell — so the
    // quoting is what is under test rather than the wording of the assertion.
    const quoted = /"(git worktree remove [^"]+)"/.exec(outcome.message)?.[1];
    expect(quoted).toBeDefined();
    await shell(repositoryPath, quoted ?? "");
    expect(await worktreeCount(repositoryPath)).toBe(1);
  });

  /**
   * The case the quoting cannot rescue, and the sentence that is honest about it.
   *
   * `shellPath` runs the path through `printable` *before* quoting it, and `printable` maps a control
   * character to `?` — which is itself a legal filename character. So on a repository whose root
   * carries a newline the printed remedy is not a command that fails to parse; it is a command that
   * parses, addresses a directory that does not exist, and exits 128 naming a path the operator has
   * never seen. Quoting the raw path instead would put the control character in the refusal, which is
   * what `printable` exists to stop, so the remedy cannot be made copyable and the message says so.
   *
   * Both halves are asserted, and the first is what makes the second necessary: the command lifted
   * out of the sentence is *run*, the way the spaced-path test above runs its own, and it has to fail
   * — otherwise there is nothing here to warn about.
   */
  it("says the printed path is not the real one when the repository path cannot be shown", async () => {
    const repositoryPath = await repositoryWithAnUnshowablePath();
    expect(repositoryPath).toContain("\n");
    const first = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("occupied");

    // The newline is gone from the message, which is the sanitising working, and the `?` it left
    // behind is what makes the remedy wrong rather than unparseable.
    expect(outcome.message).not.toContain("two\nlines");
    expect(outcome.message).toContain("two?lines");

    // Run exactly as an operator would paste it: git parses it and refuses, because that path is
    // not the working copy.
    const quoted = /"(git worktree remove [^"]+)"/.exec(outcome.message)?.[1];
    expect(quoted).toBeDefined();
    const ran = await shell(repositoryPath, quoted ?? "").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(ran).toBeInstanceOf(Error);
    expect(await worktreeCount(repositoryPath)).toBe(2);

    // So the message says what happened and names the command that prints the real bytes.
    expect(outcome.message).toContain('copy the real one out of "git worktree list"');
  });
});
