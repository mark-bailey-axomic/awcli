import { describe, expect, it } from "vitest";
import { CONTEXT_SURFACE } from "../../src/contract/surface.js";
import { NotYetImplementedError } from "../../src/runtime/not-implemented.js";
import { createContext } from "../../src/runtime/context.js";

/** Members whose machinery exists now. Everything else is declared and must fail loudly. */
const IMPLEMENTED = new Set<string>(["version"]);

const unbuiltMembers = CONTEXT_SURFACE.filter((member) => !IMPLEMENTED.has(member));

type Thrower = (...args: readonly unknown[]) => unknown;

/** The function, or every function on the sub-API, that reaching this member leads to. */
function callablesOf(value: unknown): readonly Thrower[] {
  if (typeof value === "function") return [value as Thrower];
  if (typeof value === "object" && value !== null) {
    return Object.values(value).filter(
      (entry): entry is Thrower => typeof entry === "function",
    );
  }
  return [];
}

/** Read a member, reporting whether the read itself threw — data members have to. */
function read(member: string): { threw: unknown } | { value: unknown } {
  const ctx = createContext();
  try {
    return { value: (ctx as Record<string, unknown>)[member] };
  } catch (error) {
    return { threw: error };
  }
}

function expectNamedRefusal(error: unknown, member: string): void {
  expect(error).toBeInstanceOf(NotYetImplementedError);
  const refusal = error as NotYetImplementedError;
  expect(refusal.member).toContain(member);
  expect(refusal.message).toContain(`ctx.${member}`);
  // An operator meeting this needs the ticket, or the message is just an apology.
  expect(refusal.message).toMatch(/AWCLI-\d\d/);
}

describe("a declared member that is not built yet", () => {
  it("covers every member of the surface but the one that is implemented", () => {
    expect(unbuiltMembers.length).toBe(CONTEXT_SURFACE.length - IMPLEMENTED.size);
  });

  for (const member of unbuiltMembers) {
    it(`fails loudly and by name for ctx.${member}, and never quietly returns`, async () => {
      const outcome = read(member);

      if ("threw" in outcome) {
        // Data has nothing to call, so the read is where it has to refuse.
        expectNamedRefusal(outcome.threw, member);
        return;
      }

      // Reading is safe for everything else, so a workflow can feature-detect and branch
      // without tripping over a member it decided not to use.
      expect(outcome.value).not.toBeUndefined();

      const callables = callablesOf(outcome.value);
      expect(callables.length).toBeGreaterThan(0);
      for (const callable of callables) {
        let returned: unknown;
        try {
          returned = callable();
        } catch (error) {
          // A member declared to answer synchronously refuses synchronously.
          expectNamedRefusal(error, member);
          continue;
        }
        // Anything that did not throw must have refused through its promise. Returning a
        // value here — undefined most of all — is the silent no-op the ticket forbids.
        expect(returned).toBeInstanceOf(Promise);
        await (returned as Promise<unknown>).then(
          () => expect.unreachable(`ctx.${member} resolved instead of refusing`),
          (error: unknown) => expectNamedRefusal(error, member),
        );
      }
    });
  }
});

describe("how an unbuilt member refuses", () => {
  // It has to fail through the channel the finished member will answer through, or the stub
  // teaches a shape that stops working the day it is implemented.
  it("rejects, rather than throwing, where the declared type is a promise", async () => {
    const ctx = createContext();
    // Returning a promise at all is half the claim: a synchronous throw never gets here.
    const pending = ctx.agent({ prompt: "x" });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toBeInstanceOf(NotYetImplementedError);
    await expect(ctx.exec("true")).rejects.toBeInstanceOf(NotYetImplementedError);
    await expect(ctx.git.diff()).rejects.toBeInstanceOf(NotYetImplementedError);
    await expect(ctx.fs.read("a")).rejects.toBeInstanceOf(NotYetImplementedError);
  });

  it("is catchable by the fan-out idiom BR-013 exists for", async () => {
    const ctx = createContext();
    const both = Promise.all([ctx.agent({ prompt: "a" }), ctx.agent({ prompt: "b" })]);
    await expect(both).rejects.toBeInstanceOf(NotYetImplementedError);
    await expect(
      ctx.agent({ prompt: "a" }).catch((error: unknown) => error),
    ).resolves.toBeInstanceOf(NotYetImplementedError);
  });

  it("throws where the declared type is not a promise", async () => {
    const ctx = createContext();
    expect(() => ctx.log.info("hello")).toThrow(NotYetImplementedError);
    expect(() => ctx.schema.storable({})).toThrow(NotYetImplementedError);
    expect(() => ctx.state).toThrow(NotYetImplementedError);
    expect(() => ctx.args).toThrow(NotYetImplementedError);
  });
});

describe("NotYetImplementedError", () => {
  it("names the member and the ticket that delivers it", () => {
    const error = new NotYetImplementedError("sandbox", "AWCLI-19");
    expect(error.name).toBe("NotYetImplementedError");
    expect(error.member).toBe("sandbox");
    expect(error.ticket).toBe("AWCLI-19");
    expect(error.message).toContain("ctx.sandbox");
    expect(error.message).toContain("AWCLI-19");
  });

  it("points at the check that would have avoided it", () => {
    // The message has to close the loop: supports() is what a workflow should have asked.
    expect(new NotYetImplementedError("git.branch", "AWCLI-13").message).toContain(
      'supports("git")',
    );
  });

  it("reaches an operator through the same path as any other startup failure", () => {
    expect(new NotYetImplementedError("git", "AWCLI-13")).toBeInstanceOf(Error);
  });
});
