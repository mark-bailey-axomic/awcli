import { describe, expect, it } from "vitest";
import {
  RESERVED_RUN_NAMES,
  defaultRunName,
  resolveRunName,
  runLockPath,
  runtimeRoot,
  validateRunName,
} from "../../src/runtime/run-identity.js";

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
    if (!result.ok) expect(result.problem).toBe("reserved");
  });

  it("refuses when nothing usable can be derived", () => {
    const result = defaultRunName("./workflows/---.ts");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("--name");
  });
});

describe("where a run's files live", () => {
  it("keeps every run under one runtime path, so one ignore line covers them all", () => {
    expect(runtimeRoot("/repo")).toBe("/repo/.awcli/run");
    expect(runLockPath("/repo", "triage")).toBe("/repo/.awcli/run/triage/lock");
  });

  it("gives differently named runs different lock files", () => {
    expect(runLockPath("/repo", "triage")).not.toBe(
      runLockPath("/repo", "release-notes"),
    );
  });
});
