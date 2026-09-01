import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLOT,
  RESERVED_RUN_NAMES,
  defaultRunName,
  resolveRunName,
  runLockPath,
  runtimeRoot,
  validateRunName,
  validateSlotName,
  workspaceBranch,
  worktreePath,
  type RunName,
  type SlotName,
} from "../../src/runtime/run-identity.js";

/** Through the validator, never a cast: a test that casts would pass with validation removed. */
function slotName(name: string): SlotName {
  const result = validateSlotName(name);
  if (!result.ok) throw new Error(`test used an invalid slot name: ${result.message}`);
  return result.slot;
}

describe("naming a run", () => {
  it("takes the name the operator passed", () => {
    expect(
      resolveRunName({ explicit: "triage", workflowReference: "./nightly.ts" }),
    ).toEqual({ ok: true, name: "triage" });
  });

  it("falls back to a name derived from the workflow reference", () => {
    expect(
      resolveRunName({ workflowReference: "./workflows/nightly-triage.ts" }),
    ).toEqual({
      ok: true,
      name: "nightly-triage",
    });
  });

  /**
   * The property BR-010 rests on. A default containing a timestamp or a random suffix would make
   * a scheduled run and a hand-started run two different writers, and the refusal that stops
   * them colliding would never fire.
   */
  it("derives the same name every time from the same reference", () => {
    const once = resolveRunName({ workflowReference: "/repos/app/workflows/triage.ts" });
    const again = resolveRunName({ workflowReference: "/repos/app/workflows/triage.ts" });
    expect(once).toEqual(again);
    expect(once).toEqual({ ok: true, name: "triage" });
  });

  it("slugifies a derived name rather than refusing a legal workflow file", () => {
    expect(defaultRunName("./workflows/Nightly Triage (v2).mts")).toEqual({
      ok: true,
      name: "nightly-triage-v2",
    });
  });

  it("refuses an explicit name instead of rewriting it", () => {
    // Two operators' distinct names must not slugify onto one lock file: that is two runs
    // believing they hold different locks while sharing one. So `--name "nightly triage"` is
    // refused, and not quietly turned into the `nightly-triage` a derived default would give.
    const result = resolveRunName({
      explicit: "nightly triage",
      workflowReference: "./nightly.ts",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("illegal-characters");
    expect(result.message).toContain("nightly triage");
    // The same string as a derived default is legal, which is what makes the asymmetry the point
    // rather than an accident of the validator.
    expect(defaultRunName("nightly triage.ts")).toEqual({
      ok: true,
      name: "nightly-triage",
    });
  });

  /**
   * Absent and empty are different. `--name ""` is almost always a shell variable that did not
   * expand, and falling back to the derived default would silently send the run at whatever the
   * workflow file happens to be called.
   */
  it("refuses an empty --name rather than falling back to the default", () => {
    const result = resolveRunName({
      explicit: "",
      workflowReference: "./workflows/nightly-triage.ts",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("empty");
  });

  it("still derives a default when --name was not passed at all", () => {
    expect(
      resolveRunName({ workflowReference: "./workflows/nightly-triage.ts" }),
    ).toEqual({
      ok: true,
      name: "nightly-triage",
    });
  });

  it.each([
    ["Triage", "not-lowercase"],
    ["nightly.lock", "git-reserved-suffix"],
  ] as const)("refuses %j", (name, problem) => {
    const result = validateRunName(name);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe(problem);
    // The message says what to use instead, rather than only what is wrong.
    expect(result.message.length).toBeGreaterThan(20);
  });

  it("refuses an explicit name that would escape the runtime directory", () => {
    const result = resolveRunName({
      explicit: "../../etc",
      workflowReference: "./nightly.ts",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toBe("traversal");
  });

  it.each([
    ["..", "traversal"],
    ["../escape", "traversal"],
    [".hidden", "illegal-characters"],
    ["trailing.", "illegal-characters"],
    ["has/slash", "illegal-characters"],
    ["", "empty"],
    ["x".repeat(65), "too-long"],
  ] as const)("refuses %j as a run name", (name, problem) => {
    const result = validateRunName(name);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe(problem);
  });

  it("accepts a single character, and dots and dashes inside", () => {
    expect(validateRunName("a").ok).toBe(true);
    expect(validateRunName("release-notes_v1.2").ok).toBe(true);
  });

  /**
   * `run/worktrees/<run>/<slot>` is a sibling of `run/<run>/`, so this name would put a run's
   * state directory and the worktree root at the same path.
   */
  it("refuses a name that collides with the layout's own directories", () => {
    for (const reserved of RESERVED_RUN_NAMES) {
      const result = validateRunName(reserved);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).toBe("reserved");
    }
  });

  it("refuses a derived name that would collide, rather than accepting the slug", () => {
    const result = defaultRunName("./workflows/worktrees.ts");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("reserved");
    // And says whose mistake it is. The validator's messages are written for a name the operator
    // typed and end by telling them to choose another one, which is not advice anyone can take
    // about a name they never chose: `./workflows/worktrees.ts` is a legal workflow reference and
    // there is no --name on the command line to change. Review found the derived path handing the
    // typed-name wording straight through.
    expect(result.message).toContain("derived");
    expect(result.message).toContain("./workflows/worktrees.ts");
    expect(result.message).toContain("--name");
    // The reason survives; the remedy written for a typed name does not. Forwarding the validator's
    // whole message left "Choose another name." in place behind the new sentence, so the refusal
    // gave two remedies and the first was the puzzle the rest of it exists to remove.
    expect(result.reason).toContain("reserved");
    expect(result.message).not.toContain("Choose another name.");
  });

  /**
   * A refused name is echoed back, and the branch that refuses one for its characters is the branch
   * where a control character is guaranteed — that is what put it there. So the refusal quoted
   * whatever the operator passed straight to a terminal: an escape sequence repaints it, and a
   * right-to-left override reverses how the rest of the sentence reads, which is worse here than in
   * a lock file's host because the operator is being told what to change.
   */
  it("does not echo a rejected name's control characters back to the terminal", () => {
    const hostile = "triage\u001b[2Jgone";
    const result = validateRunName(hostile);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain("\u001b");
    expect(result.name).not.toContain("\u001b");
    // Still recognisable enough to act on: what was refused is quoted, minus what a terminal acts on.
    expect(result.message).toContain("triage");
  });

  /**
   * The derived path echoes the *workflow reference*, not the slug — slugification turns anything
   * outside [a-z0-9._-] into a dash, so nothing hostile survives into a name. The reference itself
   * is quoted verbatim, and this is the case that reaches the message with nothing usable derived.
   */
  it("does not echo them back through a derived name either", () => {
    const result = defaultRunName("./workflows/\u202e---.ts");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain("\u202e");
    expect(result.name).not.toContain("\u202e");
  });

  it("refuses when nothing usable can be derived", () => {
    const result = defaultRunName("./workflows/---.ts");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("--name");
  });
});

/** The only way to a branded name, which is the only thing `runLockPath` accepts. */
function runName(name: string): RunName {
  const result = validateRunName(name);
  if (!result.ok) throw new Error(`test used an invalid run name: ${result.message}`);
  return result.name;
}

/** A run name the derivation tests below share. */
const TRIAGE = runName("triage");

describe("where a run's files live", () => {
  it("keeps every run under one runtime path, so one ignore line covers them all", () => {
    expect(runtimeRoot("/repo")).toBe("/repo/.awcli/run");
    expect(runLockPath("/repo", runName("triage"))).toBe("/repo/.awcli/run/triage/lock");
  });

  it("gives differently named runs different lock files", () => {
    expect(runLockPath("/repo", runName("triage"))).not.toBe(
      runLockPath("/repo", runName("release-notes")),
    );
  });
});

/**
 * The slot rules and the names they derive, beside the module that owns them.
 *
 * These assertions were written in the workspace suite, which is where the slot's *consequences*
 * live — a working copy per slot, a branch per slot. The rules themselves are this module's, and
 * the reason to move them is coverage rather than tidiness: left there,
 * `verify-workspace-gate.sh` mutated `run-identity.ts` and was killed only by the workspace suite,
 * so AWCLI-14 reworking that file for reuse would have taken the slot rules' only coverage with it,
 * without a line of `run-identity.ts` changing and with the gate still green.
 *
 * Not "every module pairs with a test file of its own name", which is what this said: `context.ts`
 * has no `context.test.ts` (it is covered by `frozen-context.test.ts` and
 * `test/contract/unbuilt-disclosure.test.ts`), and `process-probe.ts` and `workspace.ts` each have
 * several. The gate argument stands on its own and does not need the convention.
 */
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
});
