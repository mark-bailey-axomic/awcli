import { describe, expect, it } from "vitest";
import { CONTEXT_SURFACE } from "../../src/contract/surface.js";
import { createContext } from "../../src/runtime/context.js";

/**
 * BR-025 says an assignment over a context member is refused, and `readonly` in the declaration
 * is not that. It is a claim about code compiled against awcli.d.ts, and a great deal of what
 * runs in a workflow's module graph was not: a dependency written in JavaScript, a helper that
 * took `ctx` as `any`, a file whose editor never loaded the declaration. Any of those can assign
 * over log.info today and silence the audit trail BR-025 and BR-028 depend on, and the type
 * system will never have had an opinion.
 *
 * So the context and each sub-API on it are frozen, and these are the tests that say so. They
 * assign through `any` on purpose: writing the assignment in TypeScript is exactly what the
 * declaration already forbids, and a test that could not compile would be testing the compiler.
 */
describe("the context refuses to be rewritten", () => {
  /** Members whose value can be read without tripping an unimplemented-member refusal. */
  const readableMembers = (context: object): readonly [string, object][] =>
    CONTEXT_SURFACE.flatMap((member) => {
      try {
        const value: unknown = (context as Record<string, unknown>)[member];
        return typeof value === "object" && value !== null
          ? ([[member, value]] as [string, object][])
          : [];
      } catch {
        // A data member this build has not built refuses at the read. It has no object to
        // freeze, and not-implemented.test.ts is what holds it.
        return [];
      }
    });

  it("is frozen, so a member cannot be replaced", () => {
    const ctx = createContext();
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => {
      (ctx as unknown as Record<string, unknown>)["log"] = {};
    }).toThrow(TypeError);
  });

  it("freezes each sub-API too, which is where the assignment BR-025 names would go", () => {
    // Freezing the context alone stops `ctx.log = x` and leaves `ctx.log.info = x` — the
    // assignment that actually silences a log — working exactly as before.
    const ctx = createContext();
    const subApis = readableMembers(ctx);
    expect(subApis.length).toBeGreaterThan(0);
    for (const [member, value] of subApis) {
      expect(`${member}: ${Object.isFrozen(value)}`).toBe(`${member}: true`);
    }
  });

  it("throws on the assignment the rule is written about", () => {
    const ctx = createContext();
    expect(() => {
      (ctx.log as unknown as Record<string, unknown>)["info"] = () => undefined;
    }).toThrow(TypeError);
    expect(() => {
      (ctx.git as unknown as Record<string, unknown>)["commit"] = () => undefined;
    }).toThrow(TypeError);
    expect(() => {
      (ctx.fs as unknown as Record<string, unknown>)["write"] = () => undefined;
    }).toThrow(TypeError);
    expect(() => {
      (ctx.env as unknown as Record<string, unknown>)["get"] = () => undefined;
    }).toThrow(TypeError);
    expect(() => {
      (ctx.version as unknown as Record<string, unknown>)["supports"] = () => true;
    }).toThrow(TypeError);
  });

  it("refuses a member being added or deleted, not only one being overwritten", () => {
    const ctx = createContext();
    expect(() => {
      (ctx as unknown as Record<string, unknown>)["http"] = () => undefined;
    }).toThrow(TypeError);
    expect(() => {
      delete (ctx as unknown as Record<string, unknown>)["exec"];
    }).toThrow(TypeError);
  });

  it("still refuses an unbuilt member after being frozen", () => {
    // Freezing must not turn a refusal into something else: the stubs are the members, and a
    // frozen object still calls them.
    const ctx = createContext();
    expect(() => ctx.log.info("hello")).toThrow();
    expect(() => ctx.version.supports("log")).not.toThrow();
    expect(ctx.version.supports("version")).toBe(true);
  });
});
