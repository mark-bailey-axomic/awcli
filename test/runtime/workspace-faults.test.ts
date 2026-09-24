import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DisposalStack } from "../../src/runtime/disposal.js";
import {
  DEFAULT_SLOT,
  worktreePath,
  worktreesRoot,
} from "../../src/runtime/run-identity.js";
import {
  GIT_MAX_BUFFER,
  systemGitRunner,
  type GitOutcome,
  type GitRunner,
} from "../../src/runtime/git-process.js";
import { acquireWorkspace, resolveWorkspaceChoice } from "../../src/runtime/workspace.js";
import {
  repository,
  isWorktreeAdd,
  branches,
  git,
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
   * The same query not answering at all, rather than answering non-zero.
   *
   * The sibling above stages an exit status, and that is only half of "awcli could not get an
   * answer": the runner also *rejects* — for a git that has gone, for a `cwd` that has, for the 120s
   * timeout, and for an answer past `GIT_MAX_BUFFER`. The last is reachable here rather than
   * hypothetical, because this is the one query awcli deliberately runs without a pattern: measured
   * on git 2.55, 20,001 packed refs answer in 728,906 bytes, so at ~36 bytes a ref the 16MB bound
   * arrives at around 460,000 branches. Not an exposure — prior reviews recorded it as one — but on
   * such a repository the operator got the runner's sentence about bytes rather than the fault awcli
   * writes for a collision query it could not run, which is the sentence that says what awcli could
   * not tell and about which branch.
   */
  it("throws its own sentence when the collision query does not answer at all", async () => {
    const repositoryPath = await repository();
    const oversized: GitRunner = async (args, cwd) => {
      if (args[0] === "for-each-ref") {
        throw new Error(
          `git for-each-ref --format=%(refname) refs/heads printed more than ${GIT_MAX_BUFFER} bytes in ${repositoryPath}, which is more than awcli reads from one git invocation.`,
        );
      }
      return systemGitRunner(args, cwd);
    };

    const thrown = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: oversized,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    const message = thrown instanceof Error ? thrown.message : "";
    // awcli's own sentence, naming what it could not tell and which branch it is about — with the
    // runner's line carried inside it rather than instead of it.
    expect(message).toContain("could not list the branches");
    expect(message).toContain("awcli/triage/main");
    expect(message).toContain("more than awcli reads");
    // And the cause survives, which is how a caller gets at the original.
    expect(thrown instanceof Error ? thrown.cause : undefined).toBeInstanceOf(Error);
    // Nothing was provisioned, exactly as for the exit-status half.
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

  /**
   * The same escape, with the destination named to repaint the operator's terminal.
   *
   * This fault is the one message in the module whose content an attacker is *guaranteed* to reach:
   * it fires only because a symlink was planted, and what it quotes is the link's destination — a
   * filename, which may hold any byte but NUL and `/`. So the adversary picks ESC and U+202E: the
   * first repaints the screen over the fault (a fake "provisioned" line above it), the second
   * reverses the rendering of everything after it, and the operator reads a line awcli never emitted.
   * Every other foreign value in this module goes through `printable` — the collision's ref, the live
   * branch, git's own stderr, the occupied and collision targets. This one did not, for four rounds,
   * on the path where it matters most.
   */
  it("does not carry an escape or a bidi override out of the link destination into the fault", async () => {
    const repositoryPath = await repository();
    const outside = await mkdtemp(join(tmpdir(), "awcli-workspace-hostile-"));
    track(outside);
    // Reversed on purpose: rendered through the override this reads as though awcli said it did
    // nothing, which is the point of the class rather than a flourish.
    const elsewhere = join(outside, "\u001b[31mSAFE\u202egnihton-did-ilcwa");
    await mkdir(elsewhere, { recursive: true });
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    const redirecting: GitRunner = async (args, cwd) => {
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
    // Still says where it went — that path is the operator's only lead on what was planted, so
    // sanitising is not dropping it.
    expect(message).toContain("gnihton-did-ilcwa");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("\u202e");
  });
  /**
   * The same escape one level up, which the boundary check used to pass.
   *
   * `assertInsideRuntimeDirectory` resolved *both* sides — `realpath(worktrees)` and
   * `realpath(target)` — after the working copy existed and through the same layout. So a link at or
   * above `worktrees` moved the boundary along with the target and the comparison succeeded on the
   * far side of the escape: reproduced against git 2.55 with `handle.dir` naming
   * `.awcli/run/worktrees/<run>/<slot>` while the checkout and the agent's files sat outside the
   * repository, and nothing thrown. Only a link at `worktrees/<run>` or at the leaf was caught, and
   * the leaf is the only case the test above stages — so both of the plausible wrong boundaries (the
   * repository root, and a prefix test with no trailing separator) passed the suite.
   *
   * Staged at `worktrees` rather than at `.awcli`, because `.awcli` and `.awcli/run` are caught
   * earlier by `makeLayout`'s per-level check: this is the level that exists by the time the window
   * opens, which is what makes it the one the last-word check has to answer for.
   */
  it("throws when the whole worktrees directory was moved out from under it", async () => {
    const repositoryPath = await repository();
    const elsewhere = await mkdtemp(join(tmpdir(), "awcli-workspace-outside-"));
    track(elsewhere);
    const worktrees = worktreesRoot(repositoryPath);
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    const swapping: GitRunner = async (args, cwd) => {
      if (isWorktreeAdd(args)) {
        await rename(worktrees, join(elsewhere, "worktrees"));
        await symlink(join(elsewhere, "worktrees"), worktrees);
      }
      return systemGitRunner(args, cwd);
    };

    const thrown = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: swapping,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("outside");
    // Named by the path awcli believed it was using, which is the whole of the discrepancy.
    expect(message).toContain(target);
    // The working copy really did land out there — the fault is the only thing standing between that
    // and a handle whose `dir` says otherwise.
    expect(existsSync(join(elsewhere, "worktrees", "triage", "main", ".git"))).toBe(true);
  });

  /**
   * Inside the repository, outside the runtime directory — the boundary a reviewer would widen to.
   *
   * Resolving only the repository root and comparing the spelling of the rest would accept this: git
   * checks the whole tree out over `<repo>/somewhere-else` while `WorkspaceHandle.dir` and the BR-015
   * sentence both name `.awcli/run/worktrees/<run>/<slot>`. "Inside the repository" is not the
   * property this module promises; "inside the runtime directory" is.
   *
   * It is also where the *leftovers* are asserted, because this is the one failure exit reached after
   * a `git worktree add` that succeeded: the branch is cut and git has the working copy registered,
   * nothing catches, and the fault used to say only "nothing was removed" — true of the target and
   * silent about both. Asserted against git rather than against the prose: `git branch --list` and
   * `git worktree list --porcelain` are asked what is actually there, and then the message is
   * required to name them. Without that pair the leak had no test at all, on the path where the
   * operator meets it four steps later as an `occupied` refusal over a link, an `unregistered`
   * answer about a registration that does exist, and a `git branch -d` naming a working copy at a
   * path they have never seen.
   */
  it("throws when the working copy landed inside the repository but outside the runtime directory", async () => {
    const repositoryPath = await repository();
    const inside = join(repositoryPath, "somewhere-else");
    await mkdir(inside);
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    const redirecting: GitRunner = async (args, cwd) => {
      if (isWorktreeAdd(args)) {
        await rm(target, { recursive: true, force: true });
        await symlink(inside, target);
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

    // The two leftovers, from git and not from the sentence: the branch awcli cut is still a ref,
    // and git still has a working copy registered — at the link's destination, which is why the
    // next run is told there is nothing at the path awcli names.
    expect(await branches(repositoryPath)).toContain("awcli/triage/main");
    const registered = await git(repositoryPath, "worktree", "list", "--porcelain");
    expect(registered).toContain(await realpath(inside));

    // And the fault names both of them, with a command for each. Neither is "may exist": the cut
    // and the add both exited zero on this path.
    expect(message).toContain("awcli/triage/main");
    expect(message).toContain("git worktree list");
    expect(message).toContain("git branch --list awcli/triage/main");
  });

  /**
   * A sibling of `worktrees` whose name starts with it, which is the classic prefix bug.
   *
   * `placed.startsWith(boundary)` without the trailing separator accepts
   * `.awcli/run/worktrees-elsewhere/x`, and no other test in the suite distinguishes the two
   * implementations. The separator is one character and the mutation that removes it is silent.
   */
  it("throws when the working copy landed in a sibling whose name starts with the boundary", async () => {
    const repositoryPath = await repository();
    const sibling = `${worktreesRoot(repositoryPath)}-elsewhere`;
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    const redirecting: GitRunner = async (args, cwd) => {
      if (isWorktreeAdd(args)) {
        await mkdir(sibling, { recursive: true });
        await rm(target, { recursive: true, force: true });
        await symlink(sibling, target);
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
    expect(thrown instanceof Error ? thrown.message : "").toContain("outside");
    // Not a `realpath` that failed: the path resolves, it is simply not inside the boundary.
    expect(await realpath(sibling)).toBeTruthy();
  });

  /**
   * A link that redirects *within* the worktrees root, which the prefix test could not see.
   *
   * The boundary check closed five escapes and this was the sixth case: a link at `worktrees/<run>`
   * pointing at `worktrees/<other>` resolves to a path that still starts with the boundary, so
   * `placed.startsWith(boundary + sep)` was satisfied while `handle.dir` reported
   * `.awcli/run/worktrees/<run>/<slot>` and the working copy sat at
   * `.awcli/run/worktrees/<other>/<slot>`. Nothing leaves the repository, which is why it is the
   * mildest of the six — but the property the guard states is that "the path awcli checked and the
   * path git uses are the same path", and a fault channel that exists to catch that mismatch did not
   * fire for a mismatch that landed inside. Equality is what fires for both; a prefix cannot.
   *
   * Asserted with the real destination, so the test is about where the working copy went rather than
   * about the wording: the `<other>` leaf holds a checkout and the `<run>` leaf does not exist as a
   * real directory at all.
   */
  it("throws when the working copy landed in another run's directory inside the boundary", async () => {
    const repositoryPath = await repository();
    const mine = join(worktreesRoot(repositoryPath), "triage");
    const other = join(worktreesRoot(repositoryPath), "elsewhere");
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    const redirecting: GitRunner = async (args, cwd) => {
      if (isWorktreeAdd(args)) {
        // awcli has made `worktrees/triage/main`; this puts a link where the run directory was.
        await rm(mine, { recursive: true, force: true });
        await mkdir(other, { recursive: true });
        await symlink(other, mine);
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
    // The mismatch is real: the checkout is under `elsewhere`, and the path awcli would have
    // reported resolves there rather than to itself.
    expect(existsSync(join(other, "main", ".git"))).toBe(true);
    expect(await realpath(target)).toBe(join(other, "main"));
    // Still inside the worktrees root, which is what the prefix test accepted.
    expect(await realpath(target)).toContain(
      await realpath(worktreesRoot(repositoryPath)),
    );
    // And the fault names both paths, because "it is not where awcli put it" is only actionable
    // with the two of them side by side.
    expect(message).toContain(join(other, "main"));
    expect(message).toContain("where awcli expected");
  });

  /**
   * A `git worktree add` that fails the way real git fails, which nothing staged before this.
   *
   * Both failing-add tests returned a synthetic `{kind:"ran", code:128}` from the seam and created no
   * branch — an outcome real git cannot produce, because it cuts the `-b` branch before it validates
   * the target and so has *always* created it by the time it fails. So the suite exercised a path
   * production could not reach, while the path production did reach (a late collision found on
   * awcli's own branch) was reported as `branch-exists` about a branch awcli had just cut, and no
   * mutation in the gate could see it: no test observed the leak.
   *
   * Staged by putting a file in the target inside the window, which is deterministic and needs no
   * `chmod` — permissions do not fail for a test running as root, which is the reason the fs-fault
   * suite mocks them. git answers `fatal: '<path>' already exists`, exit 128 (verified on git 2.55).
   *
   * Three things are asserted, and the third is the finding: the fault carries git's own complaint
   * rather than a refusal awcli invented; no branch is left behind; and the *directory* is left
   * exactly as it was found, because `rmdir` refuses a directory with anything in it and what is in
   * this one is not awcli's.
   */
  it("throws with git's own complaint when a real worktree add fails, and leaks no branch", async () => {
    const repositoryPath = await repository();
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    const spoiling: GitRunner = async (args, cwd) => {
      if (isWorktreeAdd(args)) {
        await writeFile(join(target, "not-awcli's.txt"), "someone else's\n", "utf8");
      }
      return systemGitRunner(args, cwd);
    };

    const thrown = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: spoiling,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("git worktree add exited 128");
    expect(message).toContain("already exists");
    // The branch awcli cut for this add is gone — it had no commits on it, and left behind it makes
    // this run and slot unusable for good.
    expect(await branches(repositoryPath)).toEqual(["main"]);
    // And the file that was not awcli's is still there.
    expect(existsSync(join(target, "not-awcli's.txt"))).toBe(true);
  });
});
