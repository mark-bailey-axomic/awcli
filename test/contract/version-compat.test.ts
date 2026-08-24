import { describe, expect, it } from "vitest";
import { CONTEXT_SURFACE } from "../../src/contract/surface.js";
import { CONTRACT_VERSION } from "../../src/contract/version.js";
import { createContext } from "../../src/runtime/context.js";

/** What the v1-era workflow reported, so the test can read it without a fake context. */
let seen: string[] = [];

/**
 * A workflow as it was written when the contract was v1: it knows the twelve v1 members and
 * nothing else, and it has never heard of `http`. It is the fixed thing in this file — the
 * scenario is only meaningful because this function is never edited to accommodate a newer
 * awcli.
 */
const writtenAgainstV1: Workflow = async (ctx) => {
  const observed: string[] = [
    `contract ${ctx.version.contract}`,
    `awcli ${ctx.version.awcli}`,
  ];
  // Feature detection instead of a crash (BR-033): ask, and take the other path if absent.
  observed.push(ctx.version.supports("http") ? "http available" : "http absent");
  seen.push(...observed);
  return { done: true };
};

/** A later awcli in the same major: an extra member, higher contract version, all built. */
const laterAwcli = () =>
  createContext({
    contract: "1.4.0",
    awcli: "9.9.9",
    implemented: [...CONTEXT_SURFACE, "http"],
  });

describe("a workflow written earlier still runs on a later awcli", () => {
  it("runs unchanged against a later contract version within the same major", async () => {
    seen = [];
    await expect(writtenAgainstV1(laterAwcli())).resolves.toEqual({ done: true });
    expect(seen).toContain("contract 1.4.0");
  });

  it("lets it feature-detect a member that did not exist when it was written", async () => {
    seen = [];
    await writtenAgainstV1(laterAwcli());
    expect(seen).toContain("http available");
  });

  it("reports that member as absent on the awcli it was written for", async () => {
    seen = [];
    await writtenAgainstV1(createContext());
    expect(seen).toContain("http absent");
  });

  it("keeps the same major, which is the only breaking-change signal there is", () => {
    // BR-003: the repository's declared range gates the binary, and a major is what it
    // watches for. A later minor must therefore still satisfy a workflow written against 1.x.
    const [major] = CONTRACT_VERSION.split(".");
    expect(major).toBe("1");
    expect(laterAwcli().version.contract.split(".")[0]).toBe(major);
  });
});

describe("supports() answers whether a member can be called", () => {
  // Not whether the declaration names it. The contract is frozen ahead of its machinery
  // (BR-033), so this build declares eleven members it cannot run; answering "declared"
  // would make the documented way to avoid a crash the way to cause one.
  it("says no to a member this build declares but has not built", () => {
    expect(CONTEXT_SURFACE).toContain("agent");
    expect(createContext().version.supports("agent")).toBe(false);
  });

  it("agrees with what actually happens for every member of the surface", async () => {
    // The claim under test is that supports() never disagrees with reality. Reaching the
    // member and calling whatever it leads to — itself, or every function on its sub-API —
    // is the only way to establish that without a second hand-written list to drift.
    const ctx = createContext();
    for (const member of CONTEXT_SURFACE) {
      let usable = true;
      try {
        const value: unknown = (ctx as Record<string, unknown>)[member];
        const callables =
          typeof value === "function"
            ? [value as () => unknown]
            : typeof value === "object" && value !== null
              ? Object.values(value).filter(
                  (entry): entry is () => unknown => typeof entry === "function",
                )
              : [];
        for (const callable of callables) await callable();
      } catch {
        usable = false;
      }
      expect(`${member}: ${ctx.version.supports(member)}`).toBe(`${member}: ${usable}`);
    }
  });

  it("says yes to version, which is the member that makes the others survivable", () => {
    expect(createContext().version.supports("version")).toBe(true);
  });

  it("says no to a name this awcli has never heard of", () => {
    expect(createContext().version.supports("telemetry")).toBe(false);
  });

  it("says no to a sub-API method, which it does not answer for", () => {
    // Documented limitation rather than an oversight: teaching it dotted names is additive.
    expect(laterAwcli().version.supports("git.push")).toBe(false);
  });

  it("reports the contract version and the awcli version separately", () => {
    // They move independently: the binary ships constantly, the surface is frozen (BR-033).
    const { version } = createContext();
    expect(version.contract).toBe(CONTRACT_VERSION);
    expect(version.awcli).toMatch(/^\d+\.\d+\.\d+/);
  });
});
