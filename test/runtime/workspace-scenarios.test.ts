import { existsSync, readFileSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DisposalStack } from "../../src/runtime/disposal.js";
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
