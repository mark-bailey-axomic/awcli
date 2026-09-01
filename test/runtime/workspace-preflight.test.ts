import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
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
  git,
  bareStart,
  repository,
  notARepository,
  TRIAGE,
  consented,
  bareRepository,
} from "./workspace-support.js";

/**
 * The repository itself: absent, not a repository, no commit, detached, or somewhere above.
 */
describe("what provisioning refuses rather than does: the repository itself", () => {
  it("refuses a repository with no commit yet, on either axis", async () => {
    const repositoryPath = await bareStart();

    for (const choice of [resolveWorkspaceChoice({}), consented()]) {
      const outcome = await acquireWorkspace(new DisposalStack(), {
        repositoryPath,
        runName: TRIAGE,
        choice,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.kind).toBe("no-commit");
      expect(outcome.message).toContain("commit");
    }
    expect(existsSync(join(repositoryPath, ".awcli"))).toBe(false);
  });

  it("refuses a directory that is not a repository", async () => {
    const repositoryPath = await notARepository();
    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("not-a-repository");
    expect(outcome.message).toContain(repositoryPath);
  });

  it("refuses a detached head on the live checkout rather than inventing a branch", async () => {
    const repositoryPath = await repository();
    await git(
      repositoryPath,
      "-c",
      "advice.detachedHead=false",
      "checkout",
      "-q",
      "--detach",
    );

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: consented(),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("detached-head");
  });

  /**
   * A mistyped `--repo`, which used to be reported as a machine with no git.
   *
   * `execFile` raises ENOENT for a missing binary and for a missing `cwd` alike, so the unconditional
   * mapping sent the operator to install git on a machine that already had it — and made this refusal
   * unreachable by that route entirely. The distinction is made in `git-process.ts`; this is the half
   * an operator sees.
   */
  it("refuses a repository path that does not exist as what it is", async () => {
    const missing = join(await notARepository(), "typo", "not", "here");

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath: missing,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("not-a-repository");
    expect(outcome.message).toContain(missing);
    // The remedy is about the path, and says nothing about installing anything.
    expect(outcome.message).not.toContain("Install git");
  });

  /**
   * A `--repo` pointing at a subdirectory, which git answers about from the repository above it.
   *
   * `rev-parse --git-dir` exits 0 from every directory of a repository, so every check in the
   * preflight passed for `/repo/packages/api` — and then the whole layout was built from that path:
   * a second `.awcli/run` inside the repository, holding a whole checkout that the one generated
   * ignore line BR-030 allows does not cover, while the branch was cut in the repository above. The
   * root is what git is asked for, and the root is what the layout is derived from.
   */
  it("puts the layout at the repository root, not at the subdirectory it was pointed at", async () => {
    const repositoryPath = await repository();
    const deep = join(repositoryPath, "packages", "api");
    await mkdir(deep, { recursive: true });

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath: deep,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.workspace.dir).toBe(
      worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT),
    );
    // One runtime directory in the repository, and it is the one at the root.
    expect(existsSync(join(deep, ".awcli"))).toBe(false);
    expect(existsSync(join(repositoryPath, ".awcli", "run", "worktrees"))).toBe(true);
  });

  /**
   * git's own complaint reaches the operator, rather than being replaced by a guess at what it was.
   *
   * Any non-zero exit from `rev-parse --git-dir` was reported as "is not a git repository", which is
   * a confident sentence about a cause awcli never established: a repository owned by another uid
   * exits 128 with `fatal: detected dubious ownership` and the exact remedy, and awcli threw the
   * remedy away.
   */
  it("quotes git rather than guessing when the repository check fails", async () => {
    const repositoryPath = await repository();
    const dubious: GitRunner = async (args, cwd): Promise<GitOutcome> =>
      args[0] === "rev-parse" && args[1] === "--git-dir"
        ? {
            kind: "ran",
            code: 128,
            stdout: "",
            stderr: `fatal: detected dubious ownership in repository at '${repositoryPath}'\n`,
          }
        : systemGitRunner(args, cwd);

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: dubious,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("not-a-repository");
    expect(outcome.message).toContain("dubious ownership");
  });

  /**
   * A target occupied while git cannot say what is registered there.
   *
   * `worktreeRegistration` is documented as unable to throw, because it builds a *refusal message* —
   * but it asks git through the raw runner, and the raw runner throws for a timeout and for an
   * answer larger than awcli reads. Unguarded, that rejection escaped `acquireWorkspace` as a fault
   * on the one path the module says never throws, replacing a refusal the operator can act on with
   * `git worktree list --porcelain did not finish within 120000ms`.
   */
  it("still refuses an occupied target when git could not say what is registered there", async () => {
    const repositoryPath = await repository();
    const target = worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT);
    await mkdir(target, { recursive: true });
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
    expect(outcome.kind).toBe("occupied");
    // The third answer: both remedies named, and neither claimed.
    expect(outcome.message).toContain("git worktree remove");
    expect(outcome.message).toContain("could not ask git");
  });

  it("refuses when git is not installed", async () => {
    const repositoryPath = await repository();
    const absent: GitRunner = async () => ({
      kind: "unavailable",
      reason: "spawn git ENOENT",
    });

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
      git: absent,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("git-unavailable");
    expect(outcome.message).toContain("git");
  });

  /**
   * `WorkspaceHandle.dir` is documented absolute, and `worktreePath` joins rather than resolves — so
   * a relative repository path would hand `ctx.fs` and `ctx.exec` a path to resolve again against
   * whatever their working directory happens to be, and hand `git worktree add` a target argument
   * that a leading `-` turns into an option. No caller exists yet to have found either, which is
   * what makes it a trap set for AWCLI-20 and AWCLI-23 rather than a bug anyone has met.
   */
  it("resolves the repository path, so a relative one still gives an absolute working copy", async () => {
    const repositoryPath = await repository();
    const asked = relative(process.cwd(), repositoryPath);
    expect(isAbsolute(asked)).toBe(false);

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath: asked,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(isAbsolute(outcome.workspace.dir)).toBe(true);
    expect(outcome.workspace.dir).toBe(
      worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT),
    );
    expect(existsSync(join(outcome.workspace.dir, ".git"))).toBe(true);
  });

  /**
   * The half of that which the repository root does *not* cover, and which the gate caught.
   *
   * Once the layout follows `rev-parse --show-toplevel`, git answers absolutely however it was
   * asked, so the assertion above passes with the `resolve` at the boundary removed — the criterion
   * "the repository path is resolved at the boundary" stopped being checked by the test written for
   * it, without anyone touching that test. What still depends on the resolve is every sentence
   * raised *before* git has answered, and those are the ones an operator has to act on: a refusal
   * naming `../../../var/folders/...` is a path that only resolves from the directory awcli was run
   * in, which is not where it is being read.
   */
  it("names the repository absolutely in a refusal, however it was spelled", async () => {
    const repositoryPath = await notARepository();
    const asked = relative(process.cwd(), repositoryPath);
    expect(isAbsolute(asked)).toBe(false);

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath: asked,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("not-a-repository");
    expect(outcome.message).toContain(repositoryPath);
    expect(outcome.message).not.toContain(asked);
  });
  /**
   * A bare repository, which is a `--repo` mistake and not a machine fault.
   *
   * `rev-parse --git-dir` succeeds in one, so the not-a-repository refusal above does not fire, and
   * there is no working tree for `.awcli/run` to live in. It used to throw, defended by "there is no
   * different flag to offer" — which is the wrong test: what settles the channel is whether the
   * operator can fix it, and pointing awcli at a clone rather than at the bare one is exactly the
   * remedy `not-a-repository` already gives. The gate chain prints a refusal as a remedy and a throw
   * as a stack trace.
   *
   * It is also why the root lookup stays a second invocation rather than being folded into the first:
   * `git rev-parse --git-dir --show-toplevel` exits 128 on *both* questions here (verified on git
   * 2.55), so the combined form would report a bare repository as "that is not a git repository".
   */
  it("refuses a bare repository rather than throwing at it", async () => {
    const repositoryPath = await bareRepository();
    const stack = new DisposalStack();

    const outcome = await acquireWorkspace(stack, {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("no-working-tree");
    expect(outcome.message).toContain("working tree");
    expect(outcome.message).toContain(repositoryPath);
    expect(stack.held).toEqual([]);
  });
});
