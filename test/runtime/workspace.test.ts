import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DisposalStack } from "../../src/runtime/disposal.js";
import {
  DEFAULT_SLOT,
  validateRunName,
  validateSlotName,
  workspaceBranch,
  worktreePath,
  type RunName,
  type SlotName,
} from "../../src/runtime/run-identity.js";
import {
  systemGitRunner,
  type GitOutcome,
  type GitRunner,
} from "../../src/runtime/git-process.js";
import {
  LIVE_CHECKOUT_FLAG,
  WORKING_COPY_RESOURCE,
  acquireWorkspace,
  resolveWorkspaceChoice,
  type LiveCheckoutConsent,
  type WorkspaceChoice,
} from "../../src/runtime/workspace.js";

/**
 * Real git, against real repositories in a temp directory.
 *
 * The scenarios are about what happens to an operator's checkout, and every one of the wrong
 * implementations worth testing — the default quietly using the live tree, a slot dropped from a
 * path, a provisioning that removes what is in its way — looks identical to the right one through a
 * mocked git. So the three BDD scenarios and every refusal that git itself decides run against the
 * real thing, as `run-lock.test.ts` runs against a real filesystem. The `GitRunner` seam is used
 * only for the faults no temp repository can stage: git absent from the machine, and git failing
 * for a reason awcli does not recognise.
 */
const execFileAsync = promisify(execFile);

const repositories: string[] = [];

/** Git with nothing of the developer's own configuration in it, so a test cannot inherit a hook. */
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

/** An empty repository: initialised, no commit. There is no branch to cut from one of these. */
async function bareStart(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "awcli-workspace-"));
  repositories.push(path);
  await git(path, "init", "-q", "-b", "main", ".");
  return path;
}

/**
 * A repository on `main` with one commit, an uncommitted change, and an untracked file.
 *
 * The uncommitted change is the point of the default scenario: it is what an operator loses if
 * awcli works in their checkout.
 */
async function repository(): Promise<string> {
  const path = await bareStart();
  await writeFile(join(path, "file.txt"), "committed\n", "utf8");
  await git(path, "add", "-A");
  await git(path, "commit", "-qm", "first");
  await writeFile(join(path, "file.txt"), "committed\nuncommitted\n", "utf8");
  await writeFile(join(path, "scratch.txt"), "untracked\n", "utf8");
  return path;
}

/** A directory that is not a repository at all. */
async function notARepository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "awcli-workspace-plain-"));
  repositories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** Through the validators, never a cast: a test that casts would pass with validation removed. */
function runName(name: string): RunName {
  const result = validateRunName(name);
  if (!result.ok) throw new Error(`test used an invalid run name: ${result.message}`);
  return result.name;
}

function slotName(name: string): SlotName {
  const result = validateSlotName(name);
  if (!result.ok) throw new Error(`test used an invalid slot name: ${result.message}`);
  return result.slot;
}

const TRIAGE = runName("triage");

/**
 * The operator's own consent, from the only thing that produces one.
 *
 * Narrowed on the way out, which is itself the assertion that the resolver honours the flag: a
 * resolver that answered `worktree` for `--live-checkout` would fail here rather than silently give
 * every live-checkout test a worktree to pass against.
 */
function consented(): Extract<WorkspaceChoice, { workspace: "liveTree" }> {
  const choice = resolveWorkspaceChoice({ liveCheckout: true });
  if (choice.workspace !== "liveTree") {
    throw new Error("the resolver did not honour --live-checkout");
  }
  return choice;
}

/**
 * What the operator's working tree looks like, for a before-and-after comparison.
 *
 * `.git` is excluded and that exclusion is deliberate rather than convenient: `git worktree add`
 * writes its own bookkeeping under `.git/worktrees/`, which is git's administrative area and not
 * the operator's work. What the scenario promises is that nothing of *theirs* moved — their branch,
 * their files, and their uncommitted changes — and that awcli itself wrote nowhere but
 * `.awcli/run/`.
 */
async function checkout(repositoryPath: string) {
  const entries = (await readdir(repositoryPath))
    .filter((entry) => entry !== ".git")
    .sort();
  const status = (await git(repositoryPath, "status", "--porcelain"))
    .split("\n")
    .filter((line) => line.length > 0 && !line.includes(".awcli"))
    .sort();
  return {
    entries: entries.filter((entry) => entry !== ".awcli"),
    status,
    branch: (await git(repositoryPath, "branch", "--show-current")).trim(),
    head: (await git(repositoryPath, "rev-parse", "HEAD")).trim(),
    file: await readFile(join(repositoryPath, "file.txt"), "utf8"),
  };
}

async function branchExists(repositoryPath: string, branch: string): Promise<boolean> {
  try {
    await git(repositoryPath, "rev-parse", "--verify", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

/** Every branch in the repository, so a test can say that no *second* branch appeared. */
async function branches(repositoryPath: string): Promise<readonly string[]> {
  const printed = await git(
    repositoryPath,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  );
  return printed
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();
}

describe("provisioning a working copy", () => {
  /** A scenario of the feature file's, @BR-014, named verbatim by the it() below. */
  it("The default protects my checkout", async () => {
    const repositoryPath = await repository();
    const before = await checkout(repositoryPath);
    const stack = new DisposalStack();

    const outcome = await acquireWorkspace(stack, {
      repositoryPath,
      runName: TRIAGE,
      // No isolation requested, and nothing a workflow passes could request any: this is the
      // default path, reached by asking for nothing.
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const workspace = outcome.workspace;

    // A worktree, on its own branch, in its own directory.
    expect(workspace.isolation.workspace).toBe("worktree");
    expect(workspace.dir).not.toBe(repositoryPath);
    expect(workspace.dir).toBe(
      join(repositoryPath, ".awcli", "run", "worktrees", "triage", "main"),
    );
    expect(workspace.branch).toBe("awcli/triage/main");
    expect(await git(workspace.dir, "branch", "--show-current")).toBe(
      "awcli/triage/main\n",
    );
    expect(await workspace.head()).toBe(before.head);
    expect(await workspace.dirty()).toBe(false);

    // And the operator's checkout is exactly as it was: same branch, same head, same bytes in the
    // file they had edited, same untracked file, same working-tree entries apart from `.awcli`.
    const after = await checkout(repositoryPath);
    expect(after).toEqual(before);
    expect(after.file).toBe("committed\nuncommitted\n");

    // Nothing was written into their checkout outside `.awcli/run/`. `.awcli` is the only entry
    // that appeared, and inside it nothing but `run`.
    expect(
      (await readdir(repositoryPath)).filter((entry) => entry !== ".git").sort(),
    ).toEqual([".awcli", "file.txt", "scratch.txt"]);
    expect(await readdir(join(repositoryPath, ".awcli"))).toEqual(["run"]);

    // The worktree is registered, and preserved when it is released.
    expect(stack.held).toEqual([WORKING_COPY_RESOURCE]);
    const report = await stack.unwind();
    expect(report.ok).toBe(true);
    expect(report.released).toEqual([
      { name: WORKING_COPY_RESOURCE, disposition: "preserve" },
    ]);
    expect(stack.leaks()).toEqual([]);
  });

  /** @BR-014's other half, and the one the operator has to ask for. Named by the it() below. */
  it("Working on the live checkout requires asking for it", async () => {
    const repositoryPath = await repository();
    const before = await checkout(repositoryPath);

    // Without the operator's consent the live checkout is unobtainable — and, crucially, awcli
    // does not quietly give a worktree instead. A downgrade would be a workflow's request for the
    // live tree being answered with something else, silently, which is the failure BR-014's
    // "refuse to work there silently" cuts both ways on.
    const forged = new DisposalStack();
    const refused = await acquireWorkspace(forged, {
      repositoryPath,
      runName: TRIAGE,
      choice: { workspace: "liveTree", consent: {} as LiveCheckoutConsent },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.kind).toBe("live-checkout-not-consented");
    expect(refused.message).toContain(LIVE_CHECKOUT_FLAG);
    expect(forged.held).toEqual([]);
    expect(await branches(repositoryPath)).toEqual(["main"]);
    expect(existsSync(join(repositoryPath, ".awcli"))).toBe(false);
    expect(await checkout(repositoryPath)).toEqual(before);

    // A consent value is a module-private identity, not a shape. A frozen empty object is what one
    // looks like from the outside, and a spread copy of the real one carries every property it has.
    const real = consented();
    for (const impostor of [
      Object.freeze({}) as LiveCheckoutConsent,
      { ...real.consent },
      JSON.parse("{}") as LiveCheckoutConsent,
    ]) {
      const outcome = await acquireWorkspace(new DisposalStack(), {
        repositoryPath,
        runName: TRIAGE,
        choice: { workspace: "liveTree", consent: impostor },
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.kind).toBe("live-checkout-not-consented");
    }

    // Asked for by the operator, it is given: their checkout, on the branch they are on.
    const stack = new DisposalStack();
    const outcome = await acquireWorkspace(stack, {
      repositoryPath,
      runName: TRIAGE,
      choice: real,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const workspace = outcome.workspace;
    expect(workspace.dir).toBe(repositoryPath);
    expect(workspace.branch).toBe("main");
    expect(workspace.branch).toBe(before.branch);
    // The choice is stated, in as many words, as the thing an operator reads (BR-015).
    expect(workspace.isolation.workspace).toBe("liveTree");
    expect(workspace.isolation.description).toContain(LIVE_CHECKOUT_FLAG);
    expect(workspace.isolation.description.toLowerCase()).toContain("uncommitted");
    expect(await workspace.dirty()).toBe(true);
    expect(await workspace.head()).toBe(before.head);

    // Nothing was created for it, and releasing it touches the checkout in no way at all.
    expect(existsSync(join(repositoryPath, ".awcli"))).toBe(false);
    expect(await branches(repositoryPath)).toEqual(["main"]);
    const report = await stack.unwind();
    expect(report.released).toEqual([
      { name: WORKING_COPY_RESOURCE, disposition: "preserve" },
    ]);
    expect(await checkout(repositoryPath)).toEqual(before);
    expect(existsSync(join(repositoryPath, ".awcli"))).toBe(false);
  });

  /**
   * The other half of the same scenario: the workflow has no channel to this choice at all.
   *
   * BR-014 puts the opt-in on the command line because the person whose uncommitted work is at
   * stake has to be the one asking. A `liveCheckout` field on `SandboxOptions` would hand that
   * decision to committed code in the repository, so the declaration's own text is the assertion.
   */
  it("gives a workflow no way to ask for the live checkout", () => {
    const declaration = readFileSync(
      fileURLToPath(new URL("../../src/contract/awcli.d.ts", import.meta.url)),
      "utf8",
    );
    const block = /interface SandboxOptions \{([^}]*)\}/.exec(declaration);
    expect(block).not.toBeNull();
    const members = [
      ...(block?.[1] ?? "").matchAll(/^\s*(?:readonly\s+)?([A-Za-z]\w*)\??:/gm),
    ]
      .map((match) => match[1])
      .sort();
    expect(members).toEqual(["name"]);
  });

  /** A scenario of the feature file's, @BR-014, named verbatim by the it() below. */
  it("Parallel agents never share a working copy", async () => {
    const repositoryPath = await repository();
    const stack = new DisposalStack();

    const outcomes = await Promise.all(
      ["reviewer", "fixer", "docs"].map((slot) =>
        acquireWorkspace(stack, {
          repositoryPath,
          runName: TRIAGE,
          slot,
          choice: resolveWorkspaceChoice({}),
        }),
      ),
    );

    const held = outcomes.map((outcome) => {
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.message);
      return outcome.workspace;
    });

    // Three directories, three branches, no overlap.
    expect(new Set(held.map((workspace) => workspace.dir)).size).toBe(3);
    expect(held.map((workspace) => workspace.branch).sort()).toEqual([
      "awcli/triage/docs",
      "awcli/triage/fixer",
      "awcli/triage/reviewer",
    ]);

    // And nothing one agent writes is observable from another's.
    const [first, second, third] = held;
    if (first === undefined || second === undefined || third === undefined) return;
    await writeFile(join(first.dir, "only-mine.txt"), "mine\n", "utf8");
    expect(existsSync(join(second.dir, "only-mine.txt"))).toBe(false);
    expect(existsSync(join(third.dir, "only-mine.txt"))).toBe(false);
    expect(await first.dirty()).toBe(true);
    expect(await second.dirty()).toBe(false);

    expect(stack.held).toEqual([
      WORKING_COPY_RESOURCE,
      WORKING_COPY_RESOURCE,
      WORKING_COPY_RESOURCE,
    ]);
  });
});

describe("the branch and the path a run and slot imply", () => {
  /**
   * The determinism criterion. A timestamp, a uuid or a counter anywhere near either of these
   * would make a resumed run unable to find what it made (BR-036) and would leave one branch per
   * iteration behind.
   */
  it("names the same branch and path for the same run and slot, every time", () => {
    const first = workspaceBranch(TRIAGE, slotName("reviewer"));
    const again = workspaceBranch(runName("triage"), slotName("reviewer"));
    expect(first).toBe(again);
    // Against a literal as well as against itself: two calls in one process agree even when both
    // are derived from the clock, and the literal is what rules that out.
    expect(first).toBe("awcli/triage/reviewer");
    expect(worktreePath("/repo", TRIAGE, slotName("reviewer"))).toBe(
      "/repo/.awcli/run/worktrees/triage/reviewer",
    );
    expect(worktreePath("/repo", TRIAGE, slotName("reviewer"))).toBe(
      worktreePath("/repo", runName("triage"), slotName("reviewer")),
    );
  });

  it("gives every slot its own branch and its own directory", () => {
    expect(workspaceBranch(TRIAGE, slotName("one"))).not.toBe(
      workspaceBranch(TRIAGE, slotName("two")),
    );
    expect(worktreePath("/repo", TRIAGE, slotName("one"))).not.toBe(
      worktreePath("/repo", TRIAGE, slotName("two")),
    );
    expect(worktreePath("/repo", TRIAGE, DEFAULT_SLOT)).not.toBe(
      worktreePath("/repo", runName("release-notes"), DEFAULT_SLOT),
    );
  });

  it("uses the default slot for a caller with no name to give", async () => {
    const repositoryPath = await repository();
    const stack = new DisposalStack();
    const outcome = await acquireWorkspace(stack, {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.workspace.branch).toBe(workspaceBranch(TRIAGE, DEFAULT_SLOT));
    expect(outcome.workspace.dir).toBe(
      worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT),
    );
  });
});

describe("a slot name is validated, never sanitised", () => {
  it.each([
    ["../../etc", "traversal"],
    ["..", "traversal"],
    ["a/b", "illegal-characters"],
    [".hidden", "illegal-characters"],
    ["trailing.", "illegal-characters"],
    ["Reviewer", "not-lowercase"],
    ["nightly.lock", "git-reserved-suffix"],
    ["", "empty"],
    ["x".repeat(65), "too-long"],
  ] as const)("refuses %j as a slot", (name, problem) => {
    const result = validateSlotName(name);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe(problem);
    expect(result.message.length).toBeGreaterThan(20);
  });

  it("accepts what a workflow would sensibly call a slot", () => {
    expect(validateSlotName("reviewer").ok).toBe(true);
    expect(validateSlotName("agent-1").ok).toBe(true);
    expect(validateSlotName("a").ok).toBe(true);
    expect(validateSlotName(DEFAULT_SLOT).ok).toBe(true);
  });

  it("does not echo a rejected slot's control characters back to the terminal", () => {
    const hostile = "reviewer\u001b[2Jgone";
    const result = validateSlotName(hostile);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain("\u001b");
    expect(result.name).not.toContain("\u001b");
    // Still recognisable enough to act on, minus what a terminal would act on.
    expect(result.message).toContain("reviewer");
  });

  /**
   * The one that matters at the boundary: a slot ultimately comes from a workflow, so an
   * unvalidated one is a path traversal out of the runtime directory *and* an illegal ref.
   */
  it("refuses a slot that would escape the runtime directory, and creates nothing", async () => {
    const repositoryPath = await repository();
    const before = await checkout(repositoryPath);
    const stack = new DisposalStack();

    const outcome = await acquireWorkspace(stack, {
      repositoryPath,
      runName: TRIAGE,
      slot: "../../../etc",
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("invalid-slot");
    expect(outcome.message).toContain("..");
    expect(stack.held).toEqual([]);
    expect(existsSync(join(repositoryPath, ".awcli"))).toBe(false);
    expect(await branches(repositoryPath)).toEqual(["main"]);
    expect(await checkout(repositoryPath)).toEqual(before);
  });
});

describe("what provisioning refuses rather than does", () => {
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
    expect(outcome.message).toContain(`git worktree remove ${target}`);
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
    expect(asked.filter((args) => args[0] === "worktree" && args[1] === "add")).toEqual(
      [],
    );
    expect(existsSync(join(repositoryPath, ".awcli", "run", "worktrees"))).toBe(false);
    expect(outcome.message).toContain("awcli/triage/main");
    expect(outcome.message).toContain("git worktree remove");
    expect(outcome.message).toContain("git branch -D awcli/triage/main");
    expect((await git(repositoryPath, "rev-parse", "awcli/triage/main")).trim()).toBe(
      before,
    );
    expect(stack.held).toEqual([]);
  });

  /**
   * The sequence an operator actually walks into, end to end.
   *
   * Release is a no-op and collection is AWCLI-22's, so today the only way to clear a working copy is
   * by hand — and the obvious way, deleting the directory, leaves git's registration for it in
   * `.git/worktrees/`. That registration holds the branch: the next run of the same name and slot is
   * refused for the branch, and `git branch -D` on it fails naming a path that is no longer there.
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
    await expect(
      git(repositoryPath, "branch", "-D", "awcli/triage/main"),
    ).rejects.toThrow(/used by worktree/);

    // The command the refusal names does work, on a directory that has already gone — and then the
    // branch can go too. Run verbatim out of the message, so wording that drifts from git's own
    // vocabulary fails here rather than in someone's terminal.
    expect(second.message).toContain(`git worktree remove ${target}`);
    await git(repositoryPath, "worktree", "remove", target);
    await git(repositoryPath, "branch", "-D", "awcli/triage/main");
    expect(await branches(repositoryPath)).toEqual(["main"]);
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
      // A next step, rather than git's own "cannot lock ref".
      expect(outcome.message).toContain("--name");
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
});

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
      repositories.push(elsewhere);
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
   * The stderr is the shape git actually produces, and that is the point of the test.
   *
   * `git worktree add` prints `Preparing worktree (...)` before it fails, so its complaint is never
   * the first line — and the first version of this mock used a single line, which is precisely why a
   * green suite covered a message that quoted the progress line and discarded the cause. This is the
   * one path the module declares it cannot explain and therefore throws on, so the quoted line is the
   * whole of the remedy.
   */
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
  /**
   * A symlink sitting at the target before awcli looks at all — the static half of the same hazard.
   *
   * `refuseSymlinkedAncestors` deliberately stops at the target's parent, so the only thing standing
   * between a committed link here and `git worktree add` following it is that awcli refuses to
   * provision over *anything* at the target. That is a refusal rather than a throw because a link is
   * one of the things a previous run or an operator can legitimately have put there, and the answer
   * — leave it alone and say so — is the same either way.
   */
  it("refuses a symlink already at the target, and follows nothing", async () => {
    const repositoryPath = await repository();
    const elsewhere = await mkdtemp(join(tmpdir(), "awcli-workspace-elsewhere-"));
    repositories.push(elsewhere);
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

  it("refuses a symlink planted at the target after the check, and follows nothing", async () => {
    const repositoryPath = await repository();
    const elsewhere = await mkdtemp(join(tmpdir(), "awcli-workspace-elsewhere-"));
    repositories.push(elsewhere);
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

  it("throws when git fails for a reason awcli does not recognise", async () => {
    const repositoryPath = await repository();
    const failing: GitRunner = async (args, cwd): Promise<GitOutcome> => {
      if (args[0] === "worktree" && args[1] === "add") {
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

describe("releasing a working copy", () => {
  /**
   * BR-021 and BR-036 together: the working copy stays on disk and its branch is never deleted,
   * because the commits are the deliverable. Release is a no-op on disk by construction — branch
   * collection is AWCLI-22's, and it is asked for, never automatic.
   */
  it("leaves the working copy and its branch on disk", async () => {
    const repositoryPath = await repository();
    const stack = new DisposalStack();
    const outcome = await acquireWorkspace(stack, {
      repositoryPath,
      runName: TRIAGE,
      slot: "reviewer",
      choice: resolveWorkspaceChoice({}),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { dir, branch } = outcome.workspace;
    await writeFile(join(dir, "work.txt"), "an agent's uncommitted work\n", "utf8");

    const report = await stack.unwind();

    expect(report.ok).toBe(true);
    expect(report.released).toEqual([
      { name: WORKING_COPY_RESOURCE, disposition: "preserve" },
    ]);
    expect(stack.leaks()).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    expect(await readFile(join(dir, "work.txt"), "utf8")).toBe(
      "an agent's uncommitted work\n",
    );
    expect(await branchExists(repositoryPath, branch)).toBe(true);
    expect(await branches(repositoryPath)).toEqual(["awcli/triage/reviewer", "main"]);
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

describe("choosing the workspace axis", () => {
  it("defaults to a worktree, and needs the operator's own flag for anything else", () => {
    expect(resolveWorkspaceChoice({}).workspace).toBe("worktree");
    expect(resolveWorkspaceChoice({ liveCheckout: false }).workspace).toBe("worktree");
    expect(resolveWorkspaceChoice({ liveCheckout: true }).workspace).toBe("liveTree");
    // The flag is spelled once, here, so the CLI wiring in AWCLI-20/AWCLI-06 and every message
    // that names it cannot drift apart.
    expect(LIVE_CHECKOUT_FLAG).toBe("--live-checkout");
  });
});
