import { describe, expect, it } from "vitest";
import { CONTEXT_SURFACE } from "../../src/contract/surface.js";
import { NotYetImplementedError } from "../../src/runtime/not-implemented.js";
import { createContext } from "../../src/runtime/context.js";

/** Members whose machinery exists now. Everything else is declared and must fail loudly. */
const IMPLEMENTED = new Set<string>(["version"]);

const unbuiltMembers = CONTEXT_SURFACE.filter((member) => !IMPLEMENTED.has(member));

/** Distinguishes "returned undefined" — the failure mode the ticket forbids — from "refused". */
const NOTHING_RETURNED = Symbol("nothing returned");

type Thrower = (...args: readonly unknown[]) => unknown;

/**
 * What a sub-API offers, without invoking anything.
 *
 * Descriptors rather than Object.values: a data member of a sub-API is a throwing getter, so
 * enumerating values would fire it and the walk would end at the first one.
 */
function membersOf(value: object): {
  callables: readonly Thrower[];
  getters: readonly (() => unknown)[];
} {
  const callables: Thrower[] = [];
  const getters: (() => unknown)[] = [];
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (typeof descriptor.get === "function") getters.push(descriptor.get.bind(value));
    else if (typeof descriptor.value === "function")
      callables.push(descriptor.value as Thrower);
  }
  return { callables, getters };
}

/** Read a member, reporting whether the read itself threw — data members have to. */
function read(member: string): { threw: unknown } | { value: unknown } {
  const ctx = createContext();
  try {
    return { value: (ctx as unknown as Record<string, unknown>)[member] };
  } catch (error) {
    return { threw: error };
  }
}

function expectNamedRefusal(error: unknown, member: string): void {
  expect(error).toBeInstanceOf(NotYetImplementedError);
  const refusal = error as NotYetImplementedError;
  expect(refusal.member).toContain(member);
  expect(refusal.message).toContain(`ctx.${member}`);
  // The message has to be actionable without a tracker: which build lacks it, and the check
  // that would have avoided it.
  expect(refusal.message).toMatch(/awcli \d+\.\d+\.\d+/);
  expect(refusal.message).toContain(`supports("${member.split(".")[0]}")`);
}

/** Call it, and assert it refused through whichever channel its declared type implies. */
async function expectRefusalOnCall(callable: Thrower, member: string): Promise<void> {
  let returned: unknown = NOTHING_RETURNED;
  try {
    returned = callable();
  } catch (error) {
    expectNamedRefusal(error, member);
    return;
  }
  // Anything that did not throw must have refused through its promise. Returning a value here
  // — undefined most of all — is the silent no-op the ticket forbids.
  expect(returned).toBeInstanceOf(Promise);
  await (returned as Promise<unknown>).then(
    () => expect.unreachable(`ctx.${member} resolved instead of refusing`),
    (error: unknown) => expectNamedRefusal(error, member),
  );
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

      // Reading is safe for a member carrying functions, so a workflow can feature-detect and
      // branch without tripping over a member it decided not to use.
      expect(outcome.value).not.toBeUndefined();
      expect(
        typeof outcome.value === "function" || typeof outcome.value === "object",
      ).toBe(true);

      if (typeof outcome.value === "function") {
        await expectRefusalOnCall(outcome.value as Thrower, member);
        return;
      }

      const { callables, getters } = membersOf(outcome.value as object);
      expect(callables.length + getters.length).toBeGreaterThan(0);
      for (const callable of callables) await expectRefusalOnCall(callable, member);
      for (const getter of getters) {
        // Data inside a sub-API follows the same rule as data at the top: refuse at the read.
        let value: unknown = NOTHING_RETURNED;
        try {
          value = getter();
        } catch (error) {
          expectNamedRefusal(error, member);
          continue;
        }
        expect(value).toBe(NOTHING_RETURNED);
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
    await expect(ctx.exec(["true"], { timeoutSeconds: 1 })).rejects.toBeInstanceOf(
      NotYetImplementedError,
    );
    await expect(ctx.git.diff()).rejects.toBeInstanceOf(NotYetImplementedError);
    await expect(ctx.git.head()).rejects.toBeInstanceOf(NotYetImplementedError);
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

  it("throws where the declared type is not a promise", () => {
    const ctx = createContext();
    expect(() => ctx.log.info("hello")).toThrow(NotYetImplementedError);
    expect(() => ctx.schema.storable({})).toThrow(NotYetImplementedError);
  });

  it("throws at the read for data, which is earlier than either", () => {
    // Documented consequence: a data member cannot be held. Destructuring the context, or
    // reaching a data field of a sub-API, refuses before anything is called.
    const ctx = createContext();
    expect(() => ctx.state).toThrow(NotYetImplementedError);
    expect(() => ctx.args).toThrow(NotYetImplementedError);
    expect(() => ctx.project).toThrow(NotYetImplementedError);
    expect(() => ctx.env).toThrow(NotYetImplementedError);
    expect(() => ctx.git.dir).toThrow(NotYetImplementedError);
    expect(() => {
      const { state } = ctx;
      return state;
    }).toThrow(NotYetImplementedError);
  });
});

describe("NotYetImplementedError", () => {
  it("names the member and the build that lacks it", () => {
    const error = new NotYetImplementedError("sandbox", "AWCLI-19", "0.1.0");
    expect(error.name).toBe("NotYetImplementedError");
    expect(error.member).toBe("sandbox");
    expect(error.awcliVersion).toBe("0.1.0");
    expect(error.message).toContain("ctx.sandbox");
    expect(error.message).toContain("awcli 0.1.0");
  });

  it("keeps the tracker id off the message an operator reads", () => {
    // Tracker ids drift as tickets split and renumber, and nobody outside the team can open
    // one. It stays on the error for maintainers instead.
    const error = new NotYetImplementedError("git.branch", "AWCLI-13", "0.1.0");
    expect(error.ticket).toBe("AWCLI-13");
    expect(error.message).not.toContain("AWCLI-13");
    expect(error.message).not.toMatch(/AWCLI-\d\d/);
  });

  it("points at the check that would have avoided it", () => {
    // The message closes the loop: supports() is what the workflow should have asked.
    expect(
      new NotYetImplementedError("git.branch", "AWCLI-13", "0.1.0").message,
    ).toContain('supports("git")');
  });

  it("reaches an operator through the same path as any other startup failure", () => {
    expect(new NotYetImplementedError("git", "AWCLI-13", "0.1.0")).toBeInstanceOf(Error);
  });
});
