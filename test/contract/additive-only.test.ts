import { describe, expect, it } from "vitest";
import { CONTEXT_SURFACE, V1_SURFACE_BASELINE } from "../../src/contract/surface.js";
import { CONTRACT_VERSION } from "../../src/contract/version.js";

describe("the v1 surface", () => {
  it("is the twelve members the contract was frozen with", () => {
    // Written out rather than derived, because this is the list the ticket froze. If it and
    // the baseline ever disagree, one of them was edited and the other should have been.
    expect([...V1_SURFACE_BASELINE]).toEqual([
      "agent",
      "sandbox",
      "state",
      "args",
      "project",
      "git",
      "exec",
      "fs",
      "log",
      "env",
      "schema",
      "version",
    ]);
  });
});

describe("the contract is additive-only within a major", () => {
  it("still has every member of the frozen v1 baseline", () => {
    // BR-033: a member may be added; removing or renaming one breaks committed workflows
    // and needs a major, which is a different change from the one this test permits.
    for (const member of V1_SURFACE_BASELINE) {
      expect(CONTEXT_SURFACE).toContain(member);
    }
  });

  it("appends, so a member is never inserted ahead of one that was already frozen", () => {
    // The additions are the whole point of the rule, so this is a prefix check rather than
    // equality. Order matters because the declaration, this list and the TDD's Contracts
    // table are meant to read the same way; reordering is churn that hides a rename.
    const prefix = CONTEXT_SURFACE.slice(0, V1_SURFACE_BASELINE.length);
    expect(prefix).toEqual([...V1_SURFACE_BASELINE]);
  });

  it("names each member once, so supports() cannot answer twice", () => {
    expect(new Set(CONTEXT_SURFACE).size).toBe(CONTEXT_SURFACE.length);
  });
});

describe("the contract version tracks the surface", () => {
  it("has bumped its minor at least once for every member added since v1", () => {
    // version.ts states this as the rule; without a test it would be a comment describing an
    // intention. A major would reset the count, and a major is exactly the review this is
    // meant to force.
    const added = CONTEXT_SURFACE.length - V1_SURFACE_BASELINE.length;
    const [major, minor] = CONTRACT_VERSION.split(".");
    expect(major).toBe("1");
    expect(Number(minor)).toBeGreaterThanOrEqual(added);
  });
});
