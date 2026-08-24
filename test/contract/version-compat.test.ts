import { describe, expect, it } from "vitest";
import { CONTEXT_SURFACE } from "../../src/contract/surface.js";
import { CONTRACT_VERSION } from "../../src/contract/contract-version.js";
import { createContext } from "../../src/runtime/context.js";
import { NotYetImplementedError } from "../../src/runtime/not-implemented.js";

/** What the v1-era workflow reported, so the test can read it without inspecting a context. */
let seen: string[] = [];

/**
 * A workflow as it was written when the contract was v1.
 *
 * It knows the twelve v1 members, it has never heard of `http`, and it is the fixed thing in
 * this file — the scenario only means anything because this function is never edited to
 * accommodate a newer awcli. It calls members rather than only reading version strings, so
 * "runs unchanged" is a claim about running.
 */
const writtenAgainstV1: Workflow = async (ctx) => {
  seen.push(`contract ${ctx.version.contract}`, `awcli ${ctx.version.awcli}`);
  // Feature detection instead of a crash (BR-033): ask, and take the other path if absent.
  seen.push(ctx.version.supports("http") ? "http available" : "http absent");

  const ran = await ctx.exec(["git", "status", "--porcelain"]);
  seen.push(`exec ${ran.exitCode}`);

  const review = await ctx.agent({ prompt: "Review it." });
  seen.push(`agent ${review.output}`, `isolation ${review.isolation.workspace}`);

  ctx.state["runs"] = (ctx.state["runs"] as number | undefined) ?? 0;
  await ctx.state.save();
  ctx.log.info("done", { branch: await ctx.git.branch() });
  return { done: true };
};

/**
 * A later awcli in the same major: a higher contract version, one member this contract does not
 * have, and — the part that matters — every member actually working.
 *
 * Built by hand rather than from createContext, because createContext refuses eleven of the
 * twelve. Handing it a longer `implemented` list would only change what supports() says while
 * every call still threw, which is the exact disagreement between supports() and reality that
 * the rest of this file asserts must never happen.
 */
function laterAwcli(extraMembers: readonly string[] = ["http"]): WorkflowContext {
  const implemented = [...CONTEXT_SURFACE, ...extraMembers];
  const isolation: Isolation = {
    workspace: "worktree",
    target: "host",
    description: "isolation: worktree — host filesystem and network reachable",
  };
  const state: Record<string, unknown> & { save: () => Promise<void> } = {
    save: () => Promise.resolve(),
  };
  return {
    // The double cast is the price of a stub standing in for a generic member: output is T,
    // and only a real driver can produce one. Nothing here reads it as anything but a string.
    agent: <T = string>(options: AgentOptions<T>) =>
      Promise.resolve({
        commits: [],
        output: options.prompt.toLowerCase() as unknown as T,
        isolation,
        logPath: "/runs/later/logs/a.log",
      }),
    sandbox: () => Promise.reject(new Error("not used by this scenario")),
    state,
    args: {},
    project: {
      commands: { test: "t", build: "b", lint: "l" },
      paths: { docs: "docs", standards: "std" },
      custom: {},
    },
    git: {
      dir: "/tmp/later",
      branch: () => Promise.resolve("awcli/later/0"),
      head: () => Promise.resolve("0".repeat(40)),
      dirty: () => Promise.resolve(false),
      log: () => Promise.resolve([]),
      diff: () => Promise.resolve(""),
      commit: (message) => Promise.resolve({ sha: "1".repeat(40), subject: message }),
    },
    exec: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    fs: { read: () => Promise.resolve(""), write: () => Promise.resolve() },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    env: {},
    schema: { storable: (value) => ({ ok: true, value: value as Storable }) },
    version: {
      contract: "1.4.0",
      awcli: "9.9.9",
      supports: (member) => implemented.includes(member),
    },
  };
}

describe("a workflow written earlier still runs on a later awcli", () => {
  it("runs unchanged against a later contract version within the same major", async () => {
    seen = [];
    await expect(writtenAgainstV1(laterAwcli())).resolves.toEqual({ done: true });
    // Not just "did not throw": it reached every member it calls, in order.
    expect(seen).toContain("contract 1.4.0");
    expect(seen).toContain("exec 0");
    expect(seen).toContain("agent review it.");
    expect(seen).toContain("isolation worktree");
  });

  it("lets it feature-detect a member that did not exist when it was written", async () => {
    seen = [];
    await writtenAgainstV1(laterAwcli(["http"]));
    expect(seen).toContain("http available");
  });

  it("still runs when that member is absent, taking the other branch", async () => {
    seen = [];
    await expect(writtenAgainstV1(laterAwcli([]))).resolves.toEqual({ done: true });
    expect(seen).toContain("http absent");
  });

  it("keeps the same major, which is the only breaking-change signal there is", () => {
    // BR-003: the repository's declared range gates the binary, and a major is what it watches
    // for. A later minor must therefore still satisfy a workflow written against 1.x.
    const [major] = CONTRACT_VERSION.split(".");
    expect(major).toBe("1");
    expect(laterAwcli().version.contract.split(".")[0]).toBe(major);
  });
});

describe("supports() answers whether a member can be called", () => {
  // Not whether the declaration names it. The contract is frozen ahead of its machinery
  // (BR-033), so this build declares eleven members it cannot run; answering "declared" would
  // make the documented way to avoid a crash the way to cause one.
  it("says no to a member this build declares but has not built", () => {
    expect(CONTEXT_SURFACE).toContain("agent");
    expect(createContext().version.supports("agent")).toBe(false);
  });

  it("agrees with what actually happens, on this build and on a later one", async () => {
    // The invariant, stated exactly: supports() is false for a member precisely when reaching
    // or calling it refuses as unimplemented. Any other failure — a stub called with no
    // arguments, a container that is not there — is the member working and disliking the call,
    // which is not what supports() is about.
    for (const [label, ctx] of [
      ["this build", createContext() as WorkflowContext],
      ["a later awcli", laterAwcli()],
    ] as const) {
      for (const member of CONTEXT_SURFACE) {
        let unimplemented = false;
        try {
          const value: unknown = (ctx as unknown as Record<string, unknown>)[member];
          for (const callable of callablesOf(value)) await callable();
        } catch (error) {
          unimplemented = error instanceof NotYetImplementedError;
        }
        expect(`${label} ${member}: ${ctx.version.supports(member)}`).toBe(
          `${label} ${member}: ${!unimplemented}`,
        );
      }
    }
  });

  it("says yes to version, which is the member that makes the others survivable", () => {
    expect(createContext().version.supports("version")).toBe(true);
  });

  it("says no to a name this awcli has never heard of", () => {
    expect(createContext().version.supports("telemetry")).toBe(false);
  });

  it("answers false for a dotted name even where the member behind it works", () => {
    // The documented limitation, pinned on a context where git is fully implemented — which is
    // the case that makes it a footgun rather than a technicality. Distinguishing it from a
    // name that simply does not exist is the whole point: both answer false, for different
    // reasons, and only one of them is a member you could have called.
    const later = laterAwcli();
    expect(later.version.supports("git")).toBe(true);
    expect(later.version.supports("git.push")).toBe(false);
    expect(later.version.supports("git.branch")).toBe(false);
    expect(typeof later.git.branch).toBe("function");
  });

  it("reports the contract version and the awcli version separately", () => {
    // They move independently: the binary ships constantly, the surface is frozen (BR-033).
    const { version } = createContext();
    expect(version.contract).toBe(CONTRACT_VERSION);
    expect(version.awcli).toMatch(/^\d+\.\d+\.\d+/);
  });
});

/** Every function reaching this member leads to, without tripping a data getter. */
function callablesOf(value: unknown): readonly (() => unknown)[] {
  if (typeof value === "function") return [value as () => unknown];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(Object.getOwnPropertyDescriptors(value)).flatMap(
    ([, descriptor]) =>
      typeof descriptor.value === "function" ? [descriptor.value as () => unknown] : [],
  );
}
