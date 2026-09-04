import { existsSync, readFileSync } from "node:fs";
import { lstat, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DisposalStack } from "../../src/runtime/disposal.js";
import { DEFAULT_SLOT, worktreePath } from "../../src/runtime/run-identity.js";
import { systemGitRunner, type GitRunner } from "../../src/runtime/git-process.js";
import {
  LIVE_CHECKOUT_FLAG,
  WORKING_COPY_RESOURCE,
  acquireWorkspace,
  resolveWorkspaceChoice,
  type LiveCheckoutConsent,
} from "../../src/runtime/workspace.js";
import {
  git,
  repository,
  checkout,
  branches,
  TRIAGE,
  consented,
} from "./workspace-support.js";

/**
 * The three BDD scenarios AWCLI-13 carries, and the axis resolver they rest on.
 *
 * Split out of one file for the reason `workspace-support.ts` gives; the fixtures are shared, the
 * assertions are not.
 */
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

    // And the operator's checkout is exactly as it was — same branch, same head, same bytes in the
    // file they had edited, same untracked file — plus exactly one new thing, named rather than
    // filtered out: the runtime directory, which shows as untracked until AWCLI-22 writes the
    // ignore line for it. Stating it is what makes this scenario able to notice a run that leaves
    // anything else behind, and what makes it fail the day the ignore line lands.
    const after = await checkout(repositoryPath);
    expect(after).toEqual({
      ...before,
      entries: [...before.entries, ".awcli"].sort(),
      status: [...before.status, "?? .awcli/"].sort(),
    });
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

  /**
   * @BR-014's other half, and the one the operator has to ask for. Named verbatim by the it() below,
   * which is the scenario-to-test link the ticket README defines and AWCLI-28 will mechanise — but
   * two of this scenario's four steps are not reachable here: nothing parses `--live-checkout` off
   * `awcli run` (AWCLI-20) and nothing prints the isolation line (AWCLI-21). That is why the
   * criterion on AWCLI-13 is deliberately unticked. What this asserts is the resolver and the
   * provisioning on either side of the two missing steps.
   */
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
    // And the sentence BR-014's no-silent-downgrade rule turns on, which naming the flag does not
    // cover: the flag appears three times in this message, so everything saying what awcli did
    // *instead* could go with the line above green — measured over the gate's ten files. What the
    // operator has to be told is that nothing was provisioned and no worktree was quietly used in
    // place of what was asked for, because a run whose reported isolation is not the isolation it
    // had is the failure this refusal exists to prevent.
    expect(refused.message).toContain(
      "Nothing was provisioned, and awcli has not silently used a worktree instead",
    );
    // The path in it is sanitised, as its four siblings in `sharedPreflight` are. This refusal is
    // the one that fires *before* the preflight, so it is the only message in the module that prints
    // `repositoryPath` when nothing — not an `lstat`, not a git round-trip, not PATH_MAX — has yet
    // bounded it: `resolve()` accepts a megabyte-long string with an ESC in it and hands it straight
    // here. Asserted with a repository that does not exist, because the point is that awcli has not
    // looked at anything yet.
    const hostile = await acquireWorkspace(new DisposalStack(), {
      repositoryPath: `/no/such/repo\u001b[2K${"x".repeat(400)}`,
      runName: TRIAGE,
      choice: { workspace: "liveTree", consent: {} as LiveCheckoutConsent },
    });
    expect(hostile.ok).toBe(false);
    if (hostile.ok) return;
    expect(hostile.kind).toBe("live-checkout-not-consented");
    expect(hostile.message).not.toContain("\u001b");
    expect(hostile.message).toContain("/no/such/repo?[2K");
    // And bounded, so a caller cannot make one refusal scroll the rest of the run off the screen.
    expect(hostile.message).not.toContain("x".repeat(400));
    expect(forged.held).toEqual([]);
    expect(await branches(repositoryPath)).toEqual(["main"]);
    expect(existsSync(join(repositoryPath, ".awcli"))).toBe(false);
    expect(await checkout(repositoryPath)).toEqual(before);

    // A consent value is a module-private identity, not a shape. A frozen empty object is what one
    // looks like from the outside, and a spread copy of the real one carries every property it has.
    // The last two are the ones with discriminating power, which is why the list has to include
    // them: `Object.create` of the real consent passes any check that walks the prototype chain,
    // and a `Proxy` around it passes any check that probes properties or asks `instanceof`. Only
    // comparing by identity refuses all five, and only these two would notice if that changed.
    const real = consented();
    for (const impostor of [
      Object.freeze({}) as LiveCheckoutConsent,
      { ...real.consent },
      JSON.parse("{}") as LiveCheckoutConsent,
      Object.create(real.consent) as LiveCheckoutConsent,
      new Proxy(real.consent, {}),
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
   * BR-013 on the live checkout, which is the one axis that cannot satisfy it by construction.
   *
   * "Concurrently-running agents each receive their own working copy on their own branch.
   * Exceptions. None." The worktree axis holds that for free — the path and the branch are both pure
   * functions of run and slot, so two slots are two directories on two branches. The live checkout
   * has one directory and one branch whatever the slot is called, so `--live-checkout` plus two
   * slots handed two agents the same tree and the same branch with nothing refusing and nothing
   * recorded. Only a refusal can hold the rule there, and every `consented()` call site in this
   * suite used a single slot, so nothing had ever asked for the second.
   *
   * The release is asserted too, because the rule is about *concurrent* agents: a run that has
   * finished with the checkout must be able to take it again, or holding it once would forbid it for
   * the life of the process.
   */
  it("refuses a second concurrent slot on the live checkout rather than sharing it", async () => {
    const repositoryPath = await repository();
    const before = await checkout(repositoryPath);

    const stack = new DisposalStack();
    const first = await acquireWorkspace(stack, {
      repositoryPath,
      runName: TRIAGE,
      choice: consented(),
      slot: "reviewer",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.workspace.dir).toBe(repositoryPath);

    // A different slot, same run, while the first is still held. This is the acquisition that used to
    // succeed and hand back the identical dir and branch.
    const second = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: consented(),
      slot: "builder",
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.kind).toBe("live-checkout-already-held");
    expect(second.slot).toBe("builder");
    // The remedy has to be one that works: a worktree each, or one after another.
    expect(second.message).toContain(LIVE_CHECKOUT_FLAG);
    // And nothing was done to the operator's checkout on the way to refusing.
    expect(await checkout(repositoryPath)).toEqual(before);
    expect(existsSync(join(repositoryPath, ".awcli"))).toBe(false);
    expect(await branches(repositoryPath)).toEqual(["main"]);

    // Released, the checkout is available again — the rule is about concurrency, not about the
    // process.
    await stack.unwind();
    const third = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: consented(),
      slot: "builder",
    });
    expect(third.ok).toBe(true);
  });

  /**
   * The consent that was read twice, either side of an await, off an object the caller supplies.
   *
   * The identity check on the token is sound and the impostor list above proves it. This is the other
   * half: `choice.workspace` and `choice.consent` were each read once for the consent check and again
   * for the dispatch, with `sharedPreflight`'s awaits in between. A `choice` whose `workspace` is a
   * getter answers the check and the dispatch differently — so the check saw `"worktree"`, skipped
   * itself as not applicable, and the dispatch then saw `"liveTree"` and opened the operator's
   * checkout. No token is forged; the forged value is the axis, and the token is simply never
   * consulted.
   *
   * The getter here counts its reads and flips after the first, which is the minimum an attacker
   * needs and also the shape an ordinary object mutated by a concurrent turn would have.
   */
  it("cannot be talked into the live checkout by a choice that changes under it", async () => {
    const repositoryPath = await repository();
    const before = await checkout(repositoryPath);
    let reads = 0;
    const shifty = {
      get workspace() {
        reads += 1;
        return reads === 1 ? "worktree" : "liveTree";
      },
    } as unknown as Parameters<typeof acquireWorkspace>[1]["choice"];

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: shifty,
    });

    // Whatever it decides, it must not be "the operator's checkout without consent". One read means
    // one decision, so this provisions a worktree — the value the first and only read gave.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.workspace.dir).not.toBe(repositoryPath);
    expect(outcome.workspace.isolation.workspace).toBe("worktree");
    // The operator's checkout was not the thing handed out, which is the property the double read
    // broke. Its branch and head rather than a deep compare: provisioning a worktree legitimately
    // adds `.awcli/run` under the repository, so the entries are *expected* to differ here — what
    // must not have moved is the checkout itself.
    const after = await checkout(repositoryPath);
    expect(after.branch).toBe(before.branch);
    expect(after.head).toBe(before.head);
    // And the axis really was consulted once. Two reads is the defect, whichever way it then went.
    expect(reads).toBe(1);
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

  /** A scenario of the feature file's, @BR-013, named verbatim by the it() below. */
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

    // Three directories, three branches, three slots, no overlap. The slot is asserted because
    // `WorkspaceHandle.slot` is what the log and the run record say this agent was, and nothing read
    // it: a handle that reported `DEFAULT_SLOT` for all three would have passed everything else here.
    expect(new Set(held.map((workspace) => workspace.dir)).size).toBe(3);
    expect(held.map((workspace) => workspace.branch).sort()).toEqual([
      "awcli/triage/docs",
      "awcli/triage/fixer",
      "awcli/triage/reviewer",
    ]);
    expect(held.map((workspace) => workspace.slot).sort()).toEqual([
      "docs",
      "fixer",
      "reviewer",
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
/**
 * The non-functional requirement that nothing watched: a bounded cost for a repository of any size.
 */
describe("what provisioning costs", () => {
  /**
   * Asserted at the *shape* of the cost rather than at a duration.
   *
   * A wall-clock threshold would be a claim about the machine running the suite, and
   * `GIT_TIMEOUT_MS` is a hang guard on one invocation rather than a bound on provisioning. What is
   * checkable, and what the requirement actually rests on, is that the number of git invocations does
   * not depend on what the repository holds — no walk of the history, no listing of the tree — and
   * that provisioning adds one working *tree* rather than cloning a second repository.
   *
   * The number is asserted exactly rather than as a ceiling, so that a call added or removed has to
   * be looked at here. Six for the worktree default: three preflight questions (`rev-parse
   * --git-dir`, `rev-parse --show-toplevel`, `rev-parse --verify --quiet HEAD`), the branch listing
   * the collision check reads, the branch claim, and the add. The first two answer one question
   * between them and could be one call — deliberately not, because the combined form exits 128 in a
   * bare repository and would report it as "not a git repository"; see `sharedPreflight`.
   */
  it("Provisioning asks git a fixed number of questions", async () => {
    const small = await repository();
    const large = await repository();
    // Enough refs and commits that anything walking either would show up in the count. Eight rather
    // than a hundred, and on the first of the two reasons that used to be given: the assertion is
    // that the count does not move at all, so any difference between the two repositories is enough.
    // The second was that this file is on the gate's critical path, and it is not — the gate runs all
    // ten files in one parallel vitest per mutation, so the critical path is the *slowest single
    // file*. Measured on this machine, this file is sixth of the eight workspace files at ~5.0s
    // against workspace-branches' ~11.4s, and the ten-file wall is within noise of branches alone. A
    // reason that points at the wrong file is worse than the one sound reason on its own.
    for (let i = 0; i < 8; i += 1) {
      await writeFile(join(large, `file-${i}.txt`), `${i}\n`, "utf8");
      await git(large, "add", "-A");
      await git(large, "commit", "-qm", `commit ${i}`);
      await git(large, "branch", `topic-${i}`);
    }

    const count = async (repositoryPath: string): Promise<number> => {
      let calls = 0;
      const counting: GitRunner = async (args, cwd) => {
        calls += 1;
        return systemGitRunner(args, cwd);
      };
      const outcome = await acquireWorkspace(new DisposalStack(), {
        repositoryPath,
        runName: TRIAGE,
        choice: resolveWorkspaceChoice({}),
        git: counting,
      });
      expect(outcome.ok).toBe(true);
      return calls;
    };

    expect(await count(small)).toBe(6);
    expect(await count(large)).toBe(6);

    // And one working tree, not a second repository: the worktree's `.git` is a pointer file.
    const target = worktreePath(small, TRIAGE, DEFAULT_SLOT);
    expect((await lstat(join(target, ".git"))).isFile()).toBe(true);
  });
});
