import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTEXT_SURFACE } from "../../src/contract/surface.js";
import { UNBUILT_MEMBERS } from "../../src/runtime/context.js";

/**
 * The declaration has to admit which of its members this build cannot run.
 *
 * BR-033 freezes the contract ahead of the machinery behind it, so an author reads a surface
 * where most members are promises. Ten of the twelve used to read as present-tense guarantees —
 * "Run an agent and wait for it" — with only the file header saying, in general terms, that some
 * of them do not. An author reading one member's comment had no way to know they were reading
 * about a member that throws, and the one place that knew was DELIVERED_BY, which no author sees.
 *
 * So each unbuilt member says so in its own comment, and this holds the comments and
 * DELIVERED_BY to each other in both directions. The second direction is the one that matters
 * over time: implementing a member means deleting its entry from DELIVERED_BY, and a disclosure
 * left behind afterwards is worse than none — it tells an author to feature-detect away a member
 * that works.
 */
const declaration = readFileSync(
  fileURLToPath(new URL("../../src/contract/awcli.d.ts", import.meta.url)),
  "utf8",
);

/** The body of `interface WorkflowContext`, which is the only place these comments count. */
function workflowContextBody(): string {
  const start = declaration.indexOf("interface WorkflowContext<");
  expect(start).not.toBe(-1);
  const open = declaration.indexOf("{", start);
  const close = declaration.indexOf("\n}", open);
  expect(close).not.toBe(-1);
  return declaration.slice(open, close);
}

/** Each member of WorkflowContext, with the doc comment immediately above it. */
function documentedMembers(): ReadonlyMap<string, string> {
  const body = workflowContextBody();
  const found = new Map<string, string>();
  const pattern = /\/\*\*([\s\S]*?)\*\/\s*readonly (\w+)[?:]/g;
  for (const match of body.matchAll(pattern)) {
    const [, comment, name] = match;
    if (comment !== undefined && name !== undefined) found.set(name, comment);
  }
  return found;
}

describe("the declaration discloses which members this build cannot run", () => {
  const documented = documentedMembers();

  it("finds a doc comment for every member of the surface", () => {
    // Without this the checks below would pass by failing to parse.
    expect([...documented.keys()].sort()).toEqual([...CONTEXT_SURFACE].sort());
  });

  it("has something to disclose, and does not claim to have built everything", () => {
    expect(UNBUILT_MEMBERS.length).toBeGreaterThan(0);
    expect(UNBUILT_MEMBERS.length).toBeLessThan(CONTEXT_SURFACE.length);
  });

  for (const member of CONTEXT_SURFACE) {
    const unbuilt = UNBUILT_MEMBERS.includes(member);

    it(`${unbuilt ? "discloses" : "does not disclose"} ctx.${member}`, () => {
      const comment = documented.get(member) ?? "";
      // The marker is the check the disclosure has to point at, spelled for this member. A
      // comment that says "not built" without it leaves the reader nothing to do about it.
      const marker = `supports("${member}")`;
      expect(`${member}: ${comment.includes(marker)}`).toBe(`${member}: ${unbuilt}`);
      if (unbuilt) expect(comment).toContain("Not built on this awcli");
    });
  }
});
