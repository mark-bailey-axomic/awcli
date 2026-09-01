import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DisposalStack } from "../../src/runtime/disposal.js";
import { DEFAULT_SLOT, worktreePath } from "../../src/runtime/run-identity.js";
import { acquireWorkspace, resolveWorkspaceChoice } from "../../src/runtime/workspace.js";
import {
  git,
  repository,
  branches,
  TRIAGE,
  consented,
  track,
} from "./workspace-support.js";

/**
 * What provisioning inherits, what it reports, and what it lets the operator's repository print.
 */
/**
 * What awcli's own git invocations inherit from the process that started awcli.
 *
 * Both of these are about provisioning being the one moment awcli acts on a repository with the
 * operator's identity and before anything of the run exists to contain it. The environment decides
 * *which* repository git acts on — `-C` and a working directory do not settle it — and a checkout
 * runs whatever `post-checkout` the repository carries.
 */
describe("what provisioning does not inherit", () => {
  /** Sets variables for the length of one call and puts the environment back however it ends. */
  async function withEnvironment<T>(
    variables: Readonly<Record<string, string>>,
    body: () => Promise<T>,
  ): Promise<T> {
    const before = new Map(
      Object.keys(variables).map((name) => [name, process.env[name]] as const),
    );
    Object.assign(process.env, variables);
    try {
      return await body();
    } finally {
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  /**
   * awcli run from somewhere that has already told git which repository to use.
   *
   * A git hook, `git rebase --exec` and `git bisect run` all export `GIT_DIR`, and git obeys it over
   * both the working directory and `-C`. Inherited, `git worktree add` cuts the branch and checks
   * the tree out in *that* repository while `WorkspaceHandle.dir`, the BR-015 sentence and every
   * refusal name the one the operator asked about. Reproduced on git 2.55 before this was written.
   */
  it("provisions in the repository it was given, not the one GIT_DIR names", async () => {
    const repositoryPath = await repository();
    const elsewhere = await repository();

    const outcome = await withEnvironment(
      {
        GIT_DIR: join(elsewhere, ".git"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.bare",
        GIT_CONFIG_VALUE_0: "false",
      },
      async () =>
        acquireWorkspace(new DisposalStack(), {
          repositoryPath,
          runName: TRIAGE,
          choice: resolveWorkspaceChoice({}),
        }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.workspace.dir).toBe(
      worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT),
    );
    // The repository awcli was pointed at got the branch and the working copy...
    expect(await branches(repositoryPath)).toEqual(["awcli/triage/main", "main"]);
    expect(existsSync(join(outcome.workspace.dir, ".git"))).toBe(true);
    // ...and the other one is exactly as it was: no branch of awcli's, nothing written into it.
    expect(await branches(elsewhere)).toEqual(["main"]);
    expect(existsSync(join(elsewhere, ".awcli"))).toBe(false);
  });

  /**
   * `git worktree add` performs a checkout, and a checkout runs `post-checkout`.
   *
   * Hooks resolve through the *common* git dir, which every worktree of a repository shares, so this
   * is not a file the run's own working copy controls: an agent in one slot can write
   * `<repo>/.git/hooks/post-checkout` and the next acquisition — any run, any slot — executes it on
   * the host, before AWCLI-25's execution boundary exists to contain anything. Provisioning is
   * awcli's own step, so awcli says which hooks it runs: none.
   */
  it("does not run the repository's post-checkout hook while provisioning", async () => {
    const repositoryPath = await repository();
    const evidence = await mkdtemp(join(tmpdir(), "awcli-workspace-hook-"));
    track(evidence);
    const marker = join(evidence, "the-hook-ran");
    const hook = join(repositoryPath, ".git", "hooks", "post-checkout");
    await mkdir(dirname(hook), { recursive: true });
    await writeFile(hook, `#!/bin/sh\necho ran > "${marker}"\n`, "utf8");
    await chmod(hook, 0o755);

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    // The provisioning still succeeds — hooks are suppressed, not depended on.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(existsSync(join(outcome.workspace.dir, ".git"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("what the isolation awcli reports says, and what it leaves to others", () => {
  /**
   * `WorkspaceIsolation` is one axis of two (ADR-0003), and the sentence has to stay inside it.
   *
   * The type's own docblock refuses to report an execution target, because no exec target exists on
   * this build and inventing one is the mis-statement BR-015 exists to prevent. The description then
   * made that claim in prose — the network and this machine's credentials named as reachable, which
   * are properties of running on the host. The BR-015 scenario wanting that sentence is scoped to an
   * agent *running without a container*; a worktree composed with one (AWCLI-19) would reuse this
   * description and tell the operator their credentials are reachable inside a container that blocks
   * them.
   */
  it.each([
    ["worktree", () => resolveWorkspaceChoice({})],
    ["liveTree", () => consented()],
  ] as const)("states the workspace axis and no more on %s", async (_axis, choose) => {
    const repositoryPath = await repository();
    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: choose(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { description } = outcome.workspace.isolation;

    // What the axis does settle is said, in as many words.
    expect(description.toLowerCase()).toContain("uncommitted");
    // What it does not settle is not claimed. These are the execution axis's to state, wherever the
    // two are composed into the contract's `Isolation`.
    expect(description).not.toMatch(/network/i);
    expect(description).not.toMatch(/credential/i);
    expect(description).not.toMatch(/reachable/i);
  });
});

describe("what the operator's own repository is allowed to put in a message", () => {
  /**
   * A branch name carrying a right-to-left override, on the live checkout.
   *
   * git's ref rules ban the C0 controls and DEL and permit everything else, the bidirectional format
   * characters included — verified: `git checkout -b` accepts one and `branch --show-current`
   * answers it back verbatim. That value went into `WorkspaceHandle.branch` and into the BR-015
   * sentence unfiltered, so the line the operator read was not the line awcli emitted: everything
   * after the override renders reversed. The refusal path already sanitises refs read out of the
   * repository (`branchCollision`'s `short`); this is the same class of value on the success path.
   */
  it("does not carry a bidi override out of the operator's branch name into what it prints", async () => {
    const repositoryPath = await repository();
    const hostile = "main\u202egnitset-elbuort";
    await git(repositoryPath, "checkout", "-q", "-b", hostile);

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: consented(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.workspace.branch).not.toContain("\u202e");
    expect(outcome.workspace.isolation.description).not.toContain("\u202e");
    // Still recognisable: what is removed is what a terminal renders differently, not the name.
    expect(outcome.workspace.branch).toContain("main");
  });
});
/**
 * What the handle's two questions inherit from the operator's own git configuration.
 */
describe("what the handle's answers do not inherit", () => {
  /**
   * `dirty()` under `status.showUntrackedFiles=no`, which is a common setting on a large repository.
   *
   * With it, `git status --porcelain` says nothing about untracked files at all — and `dirty()` is
   * documented as "whether it has uncommitted changes, what a resumed run would inherit", which an
   * untracked file certainly is. So on that operator's machine the answer was silently a different
   * answer from the one CI gives, and the parallel-agents scenario's `expect(await first.dirty())` was
   * asserting a property of the developer's `~/.gitconfig` as much as of the code. Pinned on the
   * invocation the way `NO_HOOKS` pins `core.hooksPath`; everything else the operator's configuration
   * says about `status` is still theirs to say.
   *
   * Set in the repository's own config rather than a global one, because that is the scope a worktree
   * shares — and because the suite already neutralises the global one, which would make this test
   * pass for the wrong reason.
   */
  it("reports an untracked file as dirty even when the repository has status.showUntrackedFiles off", async () => {
    const repositoryPath = await repository();
    await git(repositoryPath, "config", "status.showUntrackedFiles", "no");

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(await outcome.workspace.dirty()).toBe(false);
    await writeFile(join(outcome.workspace.dir, "new.txt"), "untracked\n", "utf8");
    expect(await outcome.workspace.dirty()).toBe(true);
  });
});
