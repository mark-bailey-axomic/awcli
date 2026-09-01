import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DisposalStack } from "../../src/runtime/disposal.js";
import { DEFAULT_SLOT, worktreePath } from "../../src/runtime/run-identity.js";
import { systemGitRunner, type GitRunner } from "../../src/runtime/git-process.js";
import { acquireWorkspace, resolveWorkspaceChoice } from "../../src/runtime/workspace.js";
import {
  git,
  repository,
  repositoryWithASpaceInItsPath,
  isWorktreeAdd,
  branches,
  shell,
  worktreeCount,
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
    // And the delete it names after that removal refuses rather than discards — see the sibling test
    // above, which asserts that against a branch that has an agent's commit on it.
    expect(second.message).toContain("git branch -d awcli/triage/main");
    expect(second.message).not.toContain("git branch -D");
    await git(repositoryPath, "worktree", "remove", target);
    await git(repositoryPath, "branch", "-d", "awcli/triage/main");
    expect(await branches(repositoryPath)).toEqual(["main"]);
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

    // git refuses, tells them why, and the commit is still there afterwards.
    await expect(
      git(repositoryPath, "branch", "-d", "awcli/triage/main"),
    ).rejects.toThrow(/not fully merged/);
    expect((await git(repositoryPath, "rev-parse", "awcli/triage/main")).trim()).toBe(
      delivered,
    );
  });

  /**
   * The losing side of two acquisitions of one run and slot, discovered at the *branch* site.
   *
   * `occupiedMessage` learned this lesson and `collisionMessage` did not: a loser reaches whichever
   * site the scheduling gives it, and cutting the branch in its own call (review round 3) moved the
   * winner's ref creation to immediately after its `mkdir` — a much wider window than the old
   * `worktree add -b`, which cut the branch and checked out in one call. So the loser's collision
   * query now routinely sees a branch that a live run cut a moment ago, and the remedy it was handed
   * was `git worktree remove '<the winner's working copy>'` followed by a delete of the winner's
   * branch, with the confident wording of a settled world.
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
});
