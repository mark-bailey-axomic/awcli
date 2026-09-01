import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DisposalStack } from "../../src/runtime/disposal.js";
import {
  systemGitRunner,
  type GitOutcome,
  type GitRunner,
} from "../../src/runtime/git-process.js";
import {
  DEFAULT_SLOT,
  validateRunName,
  worktreePath,
  type RunName,
} from "../../src/runtime/run-identity.js";
import { acquireWorkspace, resolveWorkspaceChoice } from "../../src/runtime/workspace.js";

/**
 * The failures the real-git workspace suites cannot stage against a real repository.
 *
 * The companion to it on the `run-lock-fs-faults.test.ts` precedent, and for the same reason: a
 * read-only checkout, a git that stops answering half way through an acquisition, a repository that
 * is removed underneath a run. Each one of those is a hand-written operator-facing sentence in
 * `workspace.ts` — five of them — and until this file existed the body of every one could be
 * deleted with the suite and the gate both staying green. They are the sentences an operator meets
 * on their worst day, so they are the ones least able to afford being unchecked.
 *
 * The filesystem calls are substituted rather than staged with `chmod`, following the lock's own
 * fault suite: permissions do not fail for a test running as root, and EROFS cannot be produced at
 * all without a mount. The git-side faults need no mock — `WorkspaceRequest.git` is the seam.
 */

/** Set by a test to fail the `mkdir` of a directory whose path ends with `endingWith`. */
let failMkdir: { readonly endingWith: string; readonly code: string } | undefined;

function faulted(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    mkdir: async (
      directory: Parameters<typeof real.mkdir>[0],
      options?: Parameters<typeof real.mkdir>[1],
    ) => {
      if (
        failMkdir !== undefined &&
        typeof directory === "string" &&
        directory.endsWith(failMkdir.endingWith)
      ) {
        throw faulted(failMkdir.code);
      }
      return real.mkdir(directory, options);
    },
  };
});

const execFileAsync = promisify(execFile);
const repositories: string[] = [];

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "awcli test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "awcli test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
  });
  return stdout;
}

/** A repository with one commit — canonicalised, as `workspace-support.ts` explains. */
async function repository(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "awcli-workspace-faults-"));
  repositories.push(made);
  const path = await realpath(made);
  await git(path, "init", "-q", "-b", "main", ".");
  await writeFile(join(path, "file.txt"), "committed\n", "utf8");
  await git(path, "add", "-A");
  await git(path, "commit", "-qm", "first");
  return path;
}

afterEach(async () => {
  failMkdir = undefined;
  await Promise.all(
    repositories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function runName(name: string): RunName {
  const result = validateRunName(name);
  if (!result.ok) throw new Error(`test used an invalid run name: ${result.message}`);
  return result.name;
}

const TRIAGE = runName("triage");

async function faultFrom(repositoryPath: string, runner?: GitRunner): Promise<string> {
  const thrown = await acquireWorkspace(new DisposalStack(), {
    repositoryPath,
    runName: TRIAGE,
    choice: resolveWorkspaceChoice({}),
    ...(runner === undefined ? {} : { git: runner }),
  }).then(
    (outcome) => (outcome.ok ? undefined : new Error(`refused: ${outcome.message}`)),
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(Error);
  return thrown instanceof Error ? thrown.message : "";
}

/**
 * A repository this user cannot write to, which is the one fault on this path an operator can fix
 * without knowing anything about awcli — and which arrived as `EACCES: permission denied, mkdir
 * '/repo/.awcli/run/worktrees/triage'` and a stack trace until there was a sentence for it. Both
 * `mkdir` sites are staged, because they are two guards and either can be dropped on its own.
 */
describe("a repository awcli cannot write to", () => {
  it.each(["EACCES", "EPERM", "EROFS"] as const)(
    "names the directory rather than raising a bare %s while making the layout",
    async (code) => {
      const repositoryPath = await repository();
      failMkdir = { endingWith: ".awcli", code };

      const message = await faultFrom(repositoryPath);

      expect(message).toContain(repositoryPath);
      expect(message).toContain("not writable");
      expect(message).toContain(code);
      expect(message).not.toMatch(/^simulated/);
    },
  );

  it("names the directory rather than raising a bare errno while making the working copy", async () => {
    const repositoryPath = await repository();
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    failMkdir = { endingWith: join("worktrees", "triage", "main"), code: "EACCES" };

    const message = await faultFrom(repositoryPath);

    // The *parent* is what is not writable, and it is the directory the operator has to look at.
    expect(message).toContain(dirname(target));
    expect(message).toContain("not writable");
    expect(message).not.toMatch(/^simulated/);
  });
});

/**
 * A machine that changes under a run.
 *
 * `run` exists to turn the two answers that are not answers into faults: the preflight established
 * that git can be run and that the directory is there, so a later call that says otherwise is the
 * machine changing, not a choice the operator can make differently. Both sentences say which of the
 * two it was, and both said it to nobody until this file.
 */
describe("git that stops answering half way through an acquisition", () => {
  it("says git has gone missing rather than reporting it as a missing git", async () => {
    const repositoryPath = await repository();
    const vanishing: GitRunner = async (args, cwd): Promise<GitOutcome> =>
      args.includes("worktree") && args.includes("add")
        ? { kind: "unavailable", reason: "spawn git ENOENT" }
        : systemGitRunner(args, cwd);

    const message = await faultFrom(repositoryPath, vanishing);

    expect(message).toContain("gone missing");
    expect(message).toContain("having already run it once");
    // Not the refusal for a machine with no git: that one is decided in the preflight and its
    // remedy is to install git, which is advice about a machine that had it a moment ago.
    expect(message).not.toContain("Install git");
  });

  it("says the repository is no longer there rather than that it never was", async () => {
    const repositoryPath = await repository();
    const removed: GitRunner = async (args, cwd): Promise<GitOutcome> =>
      args.includes("worktree") && args.includes("add")
        ? { kind: "no-such-directory", path: cwd }
        : systemGitRunner(args, cwd);

    const message = await faultFrom(repositoryPath, removed);

    expect(message).toContain(repositoryPath);
    expect(message).toContain("no longer there");
    // Not the not-a-repository refusal, whose remedy is to check the path they typed.
    expect(message).not.toContain("Check the path");
  });
});

/**
 * The branch cut failing, which is the call `git worktree add -b` used to do as part of the add.
 *
 * Splitting it out (AWCLI-13 review round 3) put a second exit between `mkdir(target)` and the
 * working copy, and gave it the same two failure shapes the add has: a non-zero exit, and a
 * rejection out of the runner — a git that has gone missing, a `cwd` that has, the 120s timeout, an
 * answer past `maxBuffer`, a child killed by a signal. Both leave `mkdir(target)`'s claim on disk,
 * and awcli's own empty leftover is what the *next* invocation of this run and slot is refused
 * `occupied` over. The add's pair of guards each had a test and a gate anchor; the cut's arrived with
 * neither, so the guard could be deleted with the suite green at 126 of 126 — and the sentence that
 * carries git's complaint could be emptied with it.
 *
 * Staged through the `git` seam rather than against a real repository, because a real `git branch`
 * onto a name nothing holds does not fail: every way it does fail is a fault of the machine.
 */
describe("a branch cut that fails", () => {
  /** Awcli's own `git branch <name> <sha>`, told apart from `undoOwnBranch`'s delete. */
  const isTheCut = (args: readonly string[]): boolean =>
    args.includes("branch") && !args.includes("-D") && !args.includes("-d");

  it("carries git's own complaint when git refuses the branch", async () => {
    const repositoryPath = await repository();
    const refusing: GitRunner = async (args, cwd): Promise<GitOutcome> =>
      isTheCut(args)
        ? {
            kind: "ran",
            code: 128,
            stdout: "",
            stderr: "fatal: cannot lock ref: unable to create directory\n",
          }
        : systemGitRunner(args, cwd);

    const message = await faultFrom(repositoryPath, refusing);

    expect(message).toContain("could not cut the branch awcli/triage/main");
    expect(message).toContain("git branch exited 128");
    expect(message).toContain("fatal: cannot lock ref");
    // And awcli's own claim on the path goes back, or the next invocation of this run and slot is
    // refused `occupied` over an empty directory awcli made and abandoned.
    expect(existsSync(worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT))).toBe(false);
  });

  /**
   * The tidying after a failed add, which is a ref update like the cut it undoes.
   *
   * `undoOwnBranch` deletes awcli's own branch, so it runs `reference-transaction` out of the shared
   * git dir without `NO_HOOKS` — on the *failure* path, where the operator is already being handed a
   * fault and is least placed to account for a hook that fired. It is the third mutating call of a
   * provisioning and it was the last one missing the argument.
   *
   * Staged with the add failing through the seam, so the only git call left that could run a hook is
   * the tidying: the cut carries `NO_HOOKS`, and the add never really runs.
   */
  it("runs no hook while deleting the branch its own failed add left", async () => {
    const repositoryPath = await repository();
    // Inside the repository, which `afterEach` removes. A marker at a path shared between runs is a
    // test that poisons every later one: the mutation that strips `NO_HOOKS` from this call makes the
    // hook fire *correctly*, and a marker left behind then fails the unmutated tree for good.
    const marker = join(repositoryPath, "the-hook-ran");
    const hook = join(repositoryPath, ".git", "hooks", "reference-transaction");
    await writeFile(hook, `#!/bin/sh\necho ran >> "${marker}"\n`, "utf8");
    await chmod(hook, 0o755);
    const refusing: GitRunner = async (args, cwd): Promise<GitOutcome> =>
      args.includes("worktree") && args.includes("add")
        ? { kind: "ran", code: 128, stdout: "", stderr: "fatal: no space left\n" }
        : systemGitRunner(args, cwd);

    const message = await faultFrom(repositoryPath, refusing);

    expect(message).toContain("git worktree add exited 128");
    expect(existsSync(marker)).toBe(false);
    // And the tidying did happen: the branch and the directory are both gone.
    expect(
      (
        await git(
          repositoryPath,
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads",
        )
      )
        .split("\n")
        .filter((line) => line !== ""),
    ).toEqual(["main"]);
    expect(existsSync(worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT))).toBe(false);
  });

  it("puts the directory it claimed back when the runner throws rather than exits", async () => {
    const repositoryPath = await repository();
    const vanishing: GitRunner = async (args, cwd): Promise<GitOutcome> =>
      isTheCut(args)
        ? { kind: "unavailable", reason: "spawn git ENOENT" }
        : systemGitRunner(args, cwd);

    const message = await faultFrom(repositoryPath, vanishing);

    expect(message).toContain("gone missing");
    expect(existsSync(worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT))).toBe(false);
  });
});

/**
 * The handle's own two questions, which are asked after provisioning has succeeded.
 *
 * `head()` is what a run records against itself (BR-025) and `dirty()` is what a resumed run
 * inherits, so neither may answer a guess. A git that exits non-zero for either is a fault carrying
 * git's own complaint — and the working copy's path, because by this point the operator has several.
 */
describe("a working copy that cannot answer for itself", () => {
  it.each([
    {
      what: "the commit it is on",
      failing: ["rev-parse"],
      ask: async (workspace: { head: () => Promise<string> }) => workspace.head(),
      quoting: "could not read the commit",
    },
    {
      what: "whether it has uncommitted changes",
      failing: ["status"],
      ask: async (workspace: { dirty: () => Promise<boolean> }) => workspace.dirty(),
      quoting: "has uncommitted changes",
    },
  ])("throws with git's own complaint when git cannot say $what", async (scenario) => {
    const repositoryPath = await repository();
    let provisioned = false;
    const failingAfterwards: GitRunner = async (args, cwd): Promise<GitOutcome> => {
      if (provisioned && scenario.failing.every((word) => args.includes(word))) {
        return {
          kind: "ran",
          code: 128,
          stdout: "",
          stderr: "fatal: unable to read the object store\n",
        };
      }
      return systemGitRunner(args, cwd);
    };

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: failingAfterwards,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    provisioned = true;

    const thrown = await scenario.ask(outcome.workspace).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain(scenario.quoting);
    expect(message).toContain(outcome.workspace.dir);
    expect(message).toContain("fatal: unable to read the object store");
  });
  /**
   * The target claimed between awcli's own `lstat` and its own `mkdir`.
   *
   * This is the losing side of two concurrent acquisitions of one run and slot, and it cannot be
   * staged from a real repository: which of the two sites the loser discovers the collision at
   * depends on how the two are scheduled. On this machine the loser's `mkdir` lost eight times out
   * of eight; on a CI runner the winner's `mkdir` landed before the loser's `lstat` on the first
   * attempt, so the loser saw a target that was simply there and never reached EEXIST at all. A test
   * that raced for it asserted whichever arm that machine happened to produce.
   *
   * EEXIST from awcli's own `mkdir` is the one discovery that carries evidence: the path was free
   * when awcli looked and taken by the time it created, which is another writer working right now
   * rather than something left behind. The message may say so, and this is what holds it to saying
   * so. (What makes the *other* arm safe is that it stopped claiming a settled world at all — see
   * the ordinary-directory test in workspace-occupied.test.ts.)
   */
  it("says the path was claimed under it when its own mkdir finds one there", async () => {
    const repositoryPath = await repository();
    failMkdir = { endingWith: join("worktrees", "triage", "main"), code: "EEXIST" };

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("occupied");
    expect(outcome.message).toContain("free when awcli looked");
    expect(outcome.message).toContain("Wait for that run");
    // And it does not read git's answer out to the operator as a settled one: nothing is registered
    // at a target whose checkout has not started, and saying so would be the same false confidence
    // one arm over.
    expect(outcome.message).not.toContain("git has nothing registered there");
  });
});
