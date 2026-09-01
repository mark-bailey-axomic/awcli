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
import { systemGitRunner, type GitRunner } from "../../src/runtime/git-process.js";
import { acquireWorkspace, resolveWorkspaceChoice } from "../../src/runtime/workspace.js";
import { git, repository, branches, TRIAGE, track } from "./workspace-support.js";

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
    expect(outcome.message).not.toContain(`git worktree remove ${target}`);
    expect(outcome.message).toContain("move it or delete it");

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
    expect(outcome.message).toContain("git branch -D awcli/triage/main");

    await git(repositoryPath, "worktree", "remove", target);
    await git(repositoryPath, "branch", "-D", "awcli/triage/main");
    const third = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(third.ok).toBe(true);
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
   * The early check cannot be the guarantee: between it and `git worktree add` sit a subprocess, a
   * recursive mkdir and four lstats. The window is opened deterministically here rather than raced
   * for — the git seam is the subprocess that sits inside it, so the runner plants the link on its
   * way past, which is exactly what another process doing it at that moment would look like.
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
   * A branch that appears between the collision check and the add.
   *
   * The check cannot be the guarantee here any more than the target `lstat` can: a `mkdir` and a
   * subprocess sit between it and `git worktree add -b`, and `-b` is the second line of defence that
   * catches what lands in that window. What it must not do is arrive as the thrown fault reserved for
   * conditions awcli has no sentence for — this one has a sentence already written, and an operator
   * who reads `git worktree add exited 128` is told nothing they can act on. The window is opened
   * deterministically through the git seam rather than raced for.
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
    }
    // One working copy, one branch: the loser provisioned nothing.
    expect(await branches(repositoryPath)).toEqual(["awcli/triage/main", "main"]);
  });
});
