import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DisposalStack } from "../../src/runtime/disposal.js";
import { DEFAULT_SLOT, worktreePath } from "../../src/runtime/run-identity.js";
import {
  systemGitRunner,
  type GitOutcome,
  type GitRunner,
} from "../../src/runtime/git-process.js";
import { acquireWorkspace, resolveWorkspaceChoice } from "../../src/runtime/workspace.js";
import {
  repository,
  isWorktreeAdd,
  branches,
  TRIAGE,
  consented,
  track,
} from "./workspace-support.js";

/**
 * What provisioning throws rather than refuses: the conditions with no flag to offer instead.
 */
describe("what provisioning throws rather than refuses", () => {
  /**
   * The symlink does not have to be at the outermost level to redirect the working copy.
   *
   * `mkdir` with `recursive` follows an existing symlink at *any* level, so a repository carrying a
   * committed symlink at `.awcli`, at `.awcli/run` or at `.awcli/run/worktrees` puts the working
   * copy — and everything an agent writes in it — outside the repository. Every position is staged,
   * because an implementation that inspects only the first ancestor passes a test that stages only
   * the first one, and it is a plausible implementation: `worktreePathAncestors(...)[0]` reads like
   * the check it is not. Review found exactly that hole here, one round after run-lock.test.ts had
   * already set the precedent for closing it.
   */
  it.each([
    { label: ".awcli", segments: [".awcli"] },
    { label: ".awcli/run", segments: [".awcli", "run"] },
    { label: ".awcli/run/worktrees", segments: [".awcli", "run", "worktrees"] },
    // The fourth, which `worktreePathAncestors` checks and this table stopped one short of. Staging
    // fewer positions than the code inspects is precisely how a partial implementation passes, which
    // is the standard the docblock above sets and this row is what holds the table to it.
    {
      label: ".awcli/run/worktrees/<run>",
      segments: [".awcli", "run", "worktrees", "triage"],
    },
  ])(
    "refuses a symlink at $label, which would put the working copy outside the repository",
    async ({ segments }) => {
      const repositoryPath = await repository();
      const elsewhere = await mkdtemp(join(tmpdir(), "awcli-workspace-elsewhere-"));
      track(elsewhere);
      const linkAt = join(repositoryPath, ...segments);
      await mkdir(dirname(linkAt), { recursive: true });
      await symlink(elsewhere, linkAt);

      await expect(
        acquireWorkspace(new DisposalStack(), {
          repositoryPath,
          runName: TRIAGE,
          choice: resolveWorkspaceChoice({}),
        }),
      ).rejects.toThrow(/symbolic link/);
      // And it did not follow it: nothing of awcli's landed in the directory it pointed at.
      expect(await readdir(elsewhere)).toEqual([]);
    },
  );

  /**
   * A collision query that failed, which must not read as "no collision".
   *
   * Every other git call in the module inspects its exit status; this one used its stdout
   * unconditionally, and a non-zero exit yields empty stdout — so an unreadable `packed-refs` looked
   * exactly like a repository with no awcli branches in it, and the run walked on into
   * `git worktree add` to fail there with no remedy. A question awcli could not get an answer to is a
   * fault, because there is nothing for the operator to choose differently.
   */
  it("throws when the collision query fails rather than reading it as no collision", async () => {
    const repositoryPath = await repository();
    const unreadable: GitRunner = async (args, cwd): Promise<GitOutcome> =>
      args[0] === "for-each-ref"
        ? {
            kind: "ran",
            code: 128,
            stdout: "",
            stderr: "fatal: unable to read packed-refs\n",
          }
        : systemGitRunner(args, cwd);

    await expect(
      acquireWorkspace(new DisposalStack(), {
        repositoryPath,
        runName: TRIAGE,
        choice: resolveWorkspaceChoice({}),
        git: unreadable,
      }),
    ).rejects.toThrow(/unable to read packed-refs/);

    // Nothing was provisioned on the strength of an answer awcli never got.
    expect(await branches(repositoryPath)).toEqual(["main"]);
    expect(existsSync(join(repositoryPath, ".awcli"))).toBe(false);
  });

  /**
   * `branch --show-current` failing, which is not the same thing as a detached head.
   *
   * The two used to be folded into one condition, and the sentence that came out is advice that
   * cannot be taken: git 2.21 has no `--show-current`, so an operator sitting on `main` was told to
   * check out a branch and run again. An exit status awcli did not expect is a fault naming what git
   * said, and the minimum git version is stated in the README beside the Node one.
   */
  it("throws rather than claiming a detached head when git could not answer", async () => {
    const repositoryPath = await repository();
    const oldGit: GitRunner = async (args, cwd): Promise<GitOutcome> =>
      args[0] === "branch"
        ? {
            kind: "ran",
            code: 129,
            stdout: "",
            stderr: "error: unknown option `show-current'\n",
          }
        : systemGitRunner(args, cwd);

    const thrown = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: consented(),
      git: oldGit,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("unknown option `show-current'");
    // Not the refusal, whose remedy is to check out a branch they are already on.
    expect(message).not.toContain("Check out a branch");
  });

  /**
   * An ancestor of the layout that exists as an ordinary file.
   *
   * `lstatOrMissing` converts ENOENT to "not there"; every other errno used to be rethrown as it
   * came, so a repository carrying a tracked file named `.awcli` produced `ENOTDIR: not a directory,
   * lstat ...` with a stack trace and no next step — while the sibling symlink case, which is the
   * same shape of problem, has a full sentence.
   */
  it("names a file where a directory of the layout belongs, rather than throwing a bare ENOTDIR", async () => {
    const repositoryPath = await repository();
    await writeFile(join(repositoryPath, ".awcli"), "not a directory\n", "utf8");

    const thrown = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain(join(repositoryPath, ".awcli"));
    expect(message).toMatch(/is a file/);
    expect(message).not.toMatch(/^ENOTDIR/);
  });

  /**
   * The stderr is the shape git actually produces, and that is the point of the test.
   *
   * `git worktree add` prints `Preparing worktree (...)` before it fails, so its complaint is never
   * the first line — and the first version of this mock used a single line, which is precisely why a
   * green suite covered a message that quoted the progress line and discarded the cause. This is the
   * one path the module declares it cannot explain and therefore throws on, so the quoted line is the
   * whole of the remedy.
   */
  it("throws when git fails for a reason awcli does not recognise", async () => {
    const repositoryPath = await repository();
    const failing: GitRunner = async (args, cwd): Promise<GitOutcome> => {
      if (isWorktreeAdd(args)) {
        return {
          kind: "ran",
          code: 128,
          stdout: "",
          stderr:
            "Preparing worktree (new branch 'awcli/triage/main')\nfatal: something unforeseen\n",
        };
      }
      return systemGitRunner(args, cwd);
    };

    const thrown = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: failing,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("fatal: something unforeseen");
    expect(message).not.toContain("Preparing worktree");

    // And the empty directory awcli made for git is gone again. Leaving it would block the next
    // invocation with an `occupied` refusal over awcli's own leftover, turning a transient git
    // failure into a run name that stays unusable until someone deletes a directory by hand.
    expect(
      existsSync(join(repositoryPath, ".awcli", "run", "worktrees", "triage", "main")),
    ).toBe(false);
  });
});

describe("faults the operator cannot choose differently", () => {
  /**
   * A repository whose HEAD cannot be read, which is not the same thing as one with no commit.
   *
   * `rev-parse HEAD` exits non-zero for a commitless repository *and* for a repository awcli cannot
   * read at all — dubious ownership, a dangling HEAD. Mapping every non-zero exit to "no commit yet"
   * told an operator with a full history to make their first commit. `--verify --quiet` is what
   * tells the two apart: 1 for a rev that genuinely resolves to nothing, and git's own exit status
   * with its own complaint for anything else.
   */
  it("throws rather than claiming a repository has no commit when git could not answer", async () => {
    const repositoryPath = await repository();
    const unreadable: GitRunner = async (args, cwd): Promise<GitOutcome> =>
      args[0] === "rev-parse" && args.includes("HEAD")
        ? {
            kind: "ran",
            code: 128,
            stdout: "",
            stderr: "fatal: ambiguous argument 'HEAD': unknown revision\n",
          }
        : systemGitRunner(args, cwd);

    const thrown = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: unreadable,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("ambiguous argument");
    // Not the refusal, whose remedy is to make a commit in a repository that has several.
    expect(message).not.toContain("Make one commit");
  });

  /**
   * A git that failed and printed nothing.
   *
   * Five thrown messages end by quoting git, and `gitComplaint` answered the empty string for empty
   * stderr — so the operator got an exit status, a full stop, and a trailing space that reads as a
   * message cut off mid-sentence. Silence is an answer and gets said as one.
   */
  it("says git printed nothing rather than trailing off", async () => {
    const repositoryPath = await repository();
    const silent: GitRunner = async (args, cwd): Promise<GitOutcome> =>
      isWorktreeAdd(args)
        ? { kind: "ran", code: 128, stdout: "", stderr: "" }
        : systemGitRunner(args, cwd);

    const thrown = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: silent,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("exited 128");
    expect(message).toMatch(/git printed nothing/);
    expect(message).not.toMatch(/\s$/);
  });

  /**
   * A symlink planted in the layout after awcli has checked it and before it creates anything.
   *
   * The early check is a check, not a guarantee: a subprocess sits between it and the creation of
   * the directories. `mkdir` with `recursive` follows a link at any level, so the recursive call
   * created the run's whole directory tree *inside the link's destination* before the second check
   * looked and threw — awcli had already written outside the repository by the time it refused. One
   * level at a time, non-recursively, is what makes the refusal precede the writing: `mkdir` never
   * follows a final symlink, so it answers EEXIST for one and the level is inspected before the
   * next is attempted.
   */
  it("creates nothing through a symlink planted in the layout after the check", async () => {
    const repositoryPath = await repository();
    const elsewhere = await mkdtemp(join(tmpdir(), "awcli-workspace-elsewhere-"));
    track(elsewhere);
    const planting: GitRunner = async (args, cwd) => {
      // The last git call before the layout is created, and therefore the middle of the window.
      if (args[0] === "for-each-ref") {
        await symlink(elsewhere, join(repositoryPath, ".awcli"));
      }
      return systemGitRunner(args, cwd);
    };

    await expect(
      acquireWorkspace(new DisposalStack(), {
        repositoryPath,
        runName: TRIAGE,
        choice: resolveWorkspaceChoice({}),
        git: planting,
      }),
    ).rejects.toThrow(/symbolic link/);

    // Nothing of awcli's was created through it. Not "nothing was checked out through it": the
    // directories are the part that used to land outside the repository, and they landed there
    // before anything refused.
    expect(await readdir(elsewhere)).toEqual([]);
  });

  /**
   * A working copy that ended up somewhere other than where awcli put the directory.
   *
   * Every check above is checked-then-used, and no arrangement of `lstat` and `mkdir` closes that
   * completely — the kernel resolves the path again, for git, after awcli last looked. So the
   * placement is verified once more from the answer that cannot be raced: where the target actually
   * is once git has finished with it. A working copy outside the runtime directory is a fault
   * whatever put it there, because `WorkspaceHandle.dir` and the BR-015 sentence would both name a
   * path inside the repository while an agent worked outside it.
   */
  it("throws when the working copy did not land inside the runtime directory", async () => {
    const repositoryPath = await repository();
    const elsewhere = await mkdtemp(join(tmpdir(), "awcli-workspace-elsewhere-"));
    track(elsewhere);
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    const redirecting: GitRunner = async (args, cwd) => {
      // Between awcli creating the target and git using it — the window no check can close, staged
      // here as the one thing that is inside it.
      if (isWorktreeAdd(args)) {
        await rm(target, { recursive: true, force: true });
        await symlink(elsewhere, target);
      }
      return systemGitRunner(args, cwd);
    };

    const thrown = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: redirecting,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("outside");
    expect(message).toContain(target);
  });
});
