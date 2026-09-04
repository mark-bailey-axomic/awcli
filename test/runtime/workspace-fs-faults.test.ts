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
import { gitEnvironment } from "./git-hermetic.js";

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
 *
 * The fixtures are this file's own — a repository with one commit and no dirty state, which is not
 * what `workspace-support.ts` hands out — but the *environment* is not, and that was a defect rather
 * than a difference: this file set the two config variables on the environment it gave its own
 * `git()` helper and left `process.env` alone, so `systemGitRunner` ran git with the developer's real
 * `~/.gitconfig`. A global `core.hooksPath` then turned the gate's own `runs no hook` mutation green
 * and aborted the whole gate run — measured, and recorded in `git-hermetic.ts`, which is where the
 * pins now live so that a file needing them does not have to need `repository()` as well.
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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
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

  /**
   * The add's own fault, on the two shapes where neither the add nor the tidying's delete ran.
   *
   * The two tests above reach this handler and never see its enriched sentence: the tidying succeeds
   * against real git, `undoneResidual` says nothing, and the raw error is rethrown. So the clause
   * "awcli had already made <target> and cut <branch> for it, and git stopped part-way through the
   * checkout" was reachable only with the tidying *also* failing — which is what a machine with no
   * git looks like, and is exactly the shape where no add process ran and no checkout stopped
   * part-way. The same false-confidence defect the cut's handler was corrected for, one handler
   * along, and it needed both calls staged to see.
   *
   * And then the residual itself, which is the correction this test used to assert the defect of. It
   * said `"git branch -D <branch>" did not succeed, so that branch is still there` — three claims,
   * on a shape where git never ran the delete at all: that git answered, that the answer was a
   * refusal, and (through the arm that wording selects) that a working copy is holding the ref,
   * which is the one reason git refuses this delete. Underneath them came the module's locked-worktree
   * remedy: `worktree list`, `unlock`, `remove`, `remove -f -f`, `branch -d` — five git invocations
   * offered as the next thing to type, in a repository the same fault's first sentence has just said
   * git could not be run in. `Undone.branch`'s third answer is what tells that state from a refusal,
   * so the arm for it claims nothing about why the branch survived and conditions the commands on a
   * git that can be run again.
   *
   * Both no-git shapes, because they differ in what the *first* sentence says and not in what the
   * residual may claim — and the second is the one where the false remedy read worst, since the
   * directory those commands operate in is the one that has gone.
   */
  it.each([
    {
      shape: "unavailable",
      answer: (_cwd: string): GitOutcome => ({
        kind: "unavailable",
        reason: "spawn git ENOENT",
      }),
      quoting: "gone missing",
    },
    {
      shape: "no-such-directory",
      answer: (cwd: string): GitOutcome => ({ kind: "no-such-directory", path: cwd }),
      quoting: "no longer there",
    },
  ])(
    "claims neither a checkout nor a refused delete when the add throws $shape",
    async (scenario) => {
      const repositoryPath = await repository();
      const gone: GitRunner = async (args, cwd): Promise<GitOutcome> =>
        args.includes("worktree") || args.includes("-D")
          ? scenario.answer(cwd)
          : systemGitRunner(args, cwd);

      const message = await faultFrom(repositoryPath, gone);

      expect(message).toContain(scenario.quoting);
      expect(message).toContain("and git never started the checkout");
      expect(message).not.toContain("part-way");
      // The residual, hedged exactly as far as what git said — which was nothing.
      expect(message).toContain(
        "got no answer from git about deleting awcli/triage/main",
      );
      expect(message).toContain("cannot say whether that branch is still there");
      // Not a refusal, and so not the deduction a refusal licenses.
      expect(message).not.toContain("did not succeed");
      expect(message).not.toContain("a working copy still holding the ref");
      // And the commands are conditioned on a git that can be run, not offered as the next thing to
      // type in a repository this fault has just said git could not be run in.
      expect(message).toContain("Once git can be run in that repository again");
      expect(existsSync(worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT))).toBe(false);
      // The branch really is there — the cut exited zero — which is what makes the hedge a hedge
      // about awcli's knowledge rather than about the world.
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
          .filter((line) => line.length > 0),
      ).toEqual(["awcli/triage/main", "main"]);
    },
  );
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
   * The leftover awcli could not put back, which is not another writer.
   *
   * `collisionMessage` looks at the target once more before advising anything that would touch what
   * is there, because at the *early* site anything at that path is another acquisition provisioning
   * onto this branch right now. At this site it is not: awcli made the directory itself a few lines
   * up and removed it best-effort, so a `rmdir` that did not succeed leaves awcli's own leftover —
   * and the second look cannot tell the two apart. `TargetClaim` is what tells it, and until this
   * test the parameter, the type and both arguments could be collapsed with the suite green: the
   * confident racing-writer sentence would then tell an operator to wait for a run that does not
   * exist, over a directory awcli abandoned, with the real remedies withheld.
   *
   * Staged through the seam, because everything here is a fault of the machine: the cut cannot fail
   * against a name nothing holds, and `rmdir` cannot fail on a directory nothing wrote into.
   */
  it("does not read a leftover of its own as a run provisioning onto the branch", async () => {
    const repositoryPath = await repository();
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    const cutFailsOverALeftover: GitRunner = async (args, cwd): Promise<GitOutcome> => {
      if (!isTheCut(args)) return systemGitRunner(args, cwd);
      // The branch is there when awcli asks again, which is what makes this a collision...
      await systemGitRunner(["branch", "awcli/triage/main"], cwd);
      // ...and awcli's own claim on the path cannot be given back, which is what makes the second
      // look see something.
      await writeFile(join(target, "left-behind.txt"), "not another run\n", "utf8");
      return {
        kind: "ran",
        code: 128,
        stdout: "",
        stderr: "fatal: a branch named 'awcli/triage/main' already exists\n",
      };
    };

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: cutFailsOverALeftover,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("branch-exists");
    // The leftover is there, so a second look would find it: this is the state, not a way of
    // arranging for the assertion below to pass.
    expect(existsSync(join(target, "left-behind.txt"))).toBe(true);
    expect(outcome.message).not.toContain("provisioning onto that branch right now");
    expect(outcome.message).toContain("git branch -d awcli/triage/main");
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

  /**
   * The two shapes where git never ran, which must not be told a branch "may exist".
   *
   * Five rejections reach the cut's handler, and `run` raises two of them itself: `unavailable` — git
   * could not be started — and `no-such-directory` — the repository directory has gone. No git
   * process ran in either, so no ref can exist, and the residual the handler appends for the other
   * three ("that branch may exist even though the working copy does not") is a confident sentence
   * about a state awcli never established. Worse on the second shape: it told the operator to run
   * `git branch --list` in a directory the same sentence had just said was no longer there.
   *
   * The suite was green over it because this file's own test asserted `toContain("gone missing")` and
   * nothing about what followed — the class this whole file exists for, one message along. So the
   * assertion is the negative one, and it is the only kind that can catch an addition: what makes
   * these two shapes different is not what the fault says but what it does *not*.
   */
  it.each([
    {
      shape: "unavailable",
      answer: (_cwd: string): GitOutcome => ({
        kind: "unavailable",
        reason: "spawn git ENOENT",
      }),
      quoting: "gone missing",
    },
    {
      shape: "no-such-directory",
      answer: (cwd: string): GitOutcome => ({ kind: "no-such-directory", path: cwd }),
      quoting: "no longer there",
    },
  ])(
    "puts the directory it claimed back, and names no branch, when the runner throws $shape",
    async (scenario) => {
      const repositoryPath = await repository();
      const vanishing: GitRunner = async (args, cwd): Promise<GitOutcome> =>
        isTheCut(args) ? scenario.answer(cwd) : systemGitRunner(args, cwd);

      const message = await faultFrom(repositoryPath, vanishing);

      expect(message).toContain(scenario.quoting);
      // Nothing about a ref, because git never ran: the residual, the hedge and the command that
      // would answer it are all claims about a transaction that never started.
      expect(message).not.toContain("may exist");
      expect(message).not.toContain("git branch --list");
      // And awcli's own claim on the path goes back, whichever of the two shapes it was.
      expect(existsSync(worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT))).toBe(false);
      // No branch either, which is what makes the silence above true rather than convenient.
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
          .filter((line) => line.length > 0),
      ).toEqual(["main"]);
    },
  );

  /**
   * The branch the rejection may have left, which awcli can neither put back nor prove is its own.
   *
   * `{kind: "unavailable"}` — what the test above stages — is the one shape where no ref can exist,
   * because git never ran. Three of the five that reach this handler are a git that *did* run and may
   * well have finished its ref transaction before the runner gave up on it: the 120s timeout, an
   * answer past the read bound, a child killed by a signal. `undoOwnBranch` cannot tidy those, since
   * its ownership proof is the zero exit that never arrived — so the residual is the operator's to
   * resolve, and the fault has to hand them the one command that answers it. Silently, the cost lands
   * on the *next* invocation of this run and slot: refused `branch-exists`, and told the commits on a
   * branch are the deliverable, about a commitless branch awcli abandoned.
   *
   * Staged as the timeout shape: the real `git branch` runs first, so the ref genuinely exists when
   * the rejection arrives — which is the state the sentence is about.
   */
  it("names the branch its own rejection may have left behind", async () => {
    const repositoryPath = await repository();
    const timingOut: GitRunner = async (args, cwd): Promise<GitOutcome> => {
      if (!isTheCut(args)) return systemGitRunner(args, cwd);
      // git ran, and finished, and then awcli's bound expired on it.
      await systemGitRunner(args, cwd);
      throw new Error(
        `git branch awcli/triage/main did not finish within 120000ms in ${cwd}`,
      );
    };

    const message = await faultFrom(repositoryPath, timingOut);

    expect(message).toContain("did not finish within 120000ms");
    expect(message).toContain("may exist even though the working copy does not");
    expect(message).toContain("git branch --list awcli/triage/main");
    // The branch really is there, so this is a residual and not a caveat: the command the fault names
    // is the one that tells the operator that.
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
        .filter((line) => line.length > 0),
    ).toEqual(["awcli/triage/main", "main"]);
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
   * EEXIST from awcli's own `mkdir` is the one discovery that carries evidence, and the evidence is
   * about the *window* rather than about who filled it: the path was free when awcli looked and taken
   * by the time it created, so something arrived in between. What arrived is not established. Another
   * acquisition of this run and slot is the likeliest thing, and a file, a directory or a symlink
   * somebody planted in the same window returns the identical errno — so the message names the
   * window, offers the likely cause as likely, and does not assert a run it has not seen. It said "so
   * another acquisition of this run and slot is almost certainly claiming it right now. Wait for that
   * run", which is a sentence produced unchanged for a target where no run exists, and this is what
   * holds it to the weaker claim it can actually support. (What makes the *other* arm safe is that it
   * stopped claiming a settled world at all — see the ordinary-directory test in
   * workspace-occupied.test.ts.)
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
    // The window, which the errno does establish.
    expect(outcome.message).toContain("Something arrived in that window");
    // And the hedge on the cause, which it does not. A planted file or symlink reaches this same arm.
    expect(outcome.message).toContain("the likeliest thing it was");
    expect(outcome.message).toContain("the same EEXIST");
    expect(outcome.message).not.toContain("almost certainly");
    // And it does not read git's answer out to the operator as a settled one: saying so would be the
    // same false confidence one arm over.
    expect(outcome.message).not.toContain("git has nothing registered there");
    // It also does not ask git at all, which is the discriminator saying so rather than a comment:
    // EEXIST from awcli's own `mkdir` is the strongest evidence available about a world that is
    // still changing, so there is nothing a registration answer could add.
    expect(outcome.detail).toEqual({
      kind: "occupied",
      occupancy: "raced",
      registration: undefined,
    });
    // What it says about `git worktree list` is now true, and it is the correction: this sentence
    // used to tell the operator that git would not have the working copy registered until the
    // checkout finished, so an answer read now would be the wrong one. git registers it from the
    // moment the add starts and marks the entry `locked initializing` until the checkout finishes
    // (verified on git 2.55), which makes that command the one thing that does answer the question —
    // so the sentence points at it rather than away from it.
    expect(outcome.message).toContain("git worktree list");
    expect(outcome.message).toContain("locked initializing");
    expect(outcome.message).not.toContain("an answer read now would be the wrong one");
  });
});
