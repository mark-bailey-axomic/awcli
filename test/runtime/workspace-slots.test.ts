import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DisposalStack } from "../../src/runtime/disposal.js";
import {
  DEFAULT_SLOT,
  workspaceBranch,
  worktreePath,
} from "../../src/runtime/run-identity.js";
import {
  WORKING_COPY_RESOURCE,
  acquireWorkspace,
  resolveWorkspaceChoice,
  type LiveCheckoutConsent,
} from "../../src/runtime/workspace.js";
import {
  repository,
  checkout,
  branchExists,
  branches,
  TRIAGE,
} from "./workspace-support.js";

/**
 * The slot a working copy is provisioned for, what releasing one does, and what a closing run says.
 */
describe("the slot a working copy is provisioned for", () => {
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

describe("a run that is already unwinding", () => {
  /**
   * One answer for "the run is shutting down", whichever refusal it would otherwise have been.
   *
   * `DisposalStack.acquire` refuses outright once an unwind has begun, so every condition decided
   * *inside* `open` surfaces as that refusal — but two of the eight used to be decided before the
   * stack was touched at all, and went on answering. A workflow's in-flight `sandbox({ name:
   * "Review 1" })` landing after a SIGINT was told its slot name was illegal, implying a workflow
   * bug, while its sibling `sandbox({ name: "reviewer" })` in the same moment was told the run was
   * closing. Nothing is lost by deciding them inside: a failed `open` is spliced out of the stack's
   * entries, so neither appears in the unwind report either way.
   */
  it.each([
    ["an illegal slot name", { slot: "Review 1" }],
    [
      "a live checkout with no consent",
      { choice: { workspace: "liveTree", consent: {} as LiveCheckoutConsent } },
    ],
    ["nothing wrong at all", {}],
  ] as const)(
    "answers %s the same way once the stack is closed",
    async (_case, extra) => {
      const repositoryPath = await repository();
      const stack = new DisposalStack();
      await stack.unwind();

      const thrown = await acquireWorkspace(stack, {
        repositoryPath,
        runName: TRIAGE,
        choice: resolveWorkspaceChoice({}),
        ...extra,
      }).then(
        (outcome) => outcome,
        (error: unknown) => error,
      );

      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toContain(WORKING_COPY_RESOURCE);
      // And nothing was provisioned for any of them.
      expect(existsSync(join(repositoryPath, ".awcli"))).toBe(false);
      expect(await branches(repositoryPath)).toEqual(["main"]);
    },
  );
});
