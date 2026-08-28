import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
 * The failures `workspace.test.ts` cannot stage against a real repository.
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

/** A repository with one commit — canonicalised, as `workspace.test.ts` explains. */
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
});
