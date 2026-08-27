import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What the `ps` adapter does with answers no real `ps` on the developer's machine will give.
 *
 * Three of them decide whether a *live* run's lock survives, and none can be staged for real: a
 * `ps` that does not understand `-o lstart=`, one that times out, and one asked under a locale the
 * machine has never been given. So this file substitutes the spawn. It is separate from
 * `process-probe.test.ts` because the module mock is hoisted over the whole file, and that suite's
 * whole value is that it talks to the real operating system.
 */

/** What the substituted `ps` will do on the next call. */
type Response =
  | { readonly kind: "prints"; readonly stdout: string }
  | {
      readonly kind: "fails";
      readonly code: number;
      readonly stderr: string;
      readonly killed?: boolean;
    };

let response: Response = { kind: "prints", stdout: "Wed Aug 26 19:52:19 2026" };
let lastEnv: Record<string, string | undefined> | undefined;

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  // Through the promisify hook rather than the callback: `psIdentify` uses the promisified form,
  // and node's own `execFile` carries this symbol, so a mock without it would resolve to a bare
  // stdout string and the adapter would read `undefined` for every answer.
  const fake = (): never => {
    throw new Error("the callback form of execFile is not used by psIdentify");
  };
  Object.defineProperty(fake, Symbol.for("nodejs.util.promisify.custom"), {
    value: async (
      _file: string,
      _args: readonly string[],
      options: { readonly env?: Record<string, string | undefined> },
    ) => {
      lastEnv = options.env;
      if (response.kind === "prints") return { stdout: response.stdout, stderr: "" };
      throw Object.assign(new Error("ps exited non-zero"), {
        code: response.code,
        stderr: response.stderr,
        killed: response.killed ?? false,
      });
    },
  });
  return { ...real, execFile: fake };
});

const { psIdentify } = await import("../../src/runtime/process-probe.js");

afterEach(() => {
  response = { kind: "prints", stdout: "Wed Aug 26 19:52:19 2026" };
  lastEnv = undefined;
});

describe("what ps said, and what it means", () => {
  /**
   * The pin on the locale, checked without needing the machine to have the locale installed. The
   * real-locale test in `process-probe.test.ts` skips itself where fr_FR is not present, which is
   * most of CI — so this is the one that makes removing the pin fail everywhere.
   */
  it("pins the locale for the question regardless of the caller's environment", async () => {
    const previous = process.env["LC_ALL"];
    process.env["LC_ALL"] = "fr_FR.UTF-8";
    try {
      await psIdentify(1234);
    } finally {
      if (previous === undefined) delete process.env["LC_ALL"];
      else process.env["LC_ALL"] = previous;
    }
    expect(lastEnv?.["LC_ALL"]).toBe("C");
  });

  it("reads an exit of 1 with nothing on stderr as 'no process holds that id'", async () => {
    response = { kind: "fails", code: 1, stderr: "" };
    expect(await psIdentify(1234)).toEqual({ kind: "not-found" });
  });

  /**
   * The fail-open case review found. busybox's `ps` — the one in a great many container images —
   * does not take `-o lstart=` and exits 1 saying so. Reading that status alone as "no such
   * process" would evict a *live* owner's lock on every single ask, everywhere that image runs.
   */
  it("does not read an exit of 1 with a complaint on stderr as 'no process'", async () => {
    response = { kind: "fails", code: 1, stderr: "ps: unrecognized option: o\n" };
    const answer = await psIdentify(1234);
    expect(answer.kind).toBe("unknown");
    if (answer.kind !== "unknown") return;
    expect(answer.reason).toContain("unrecognized option");
  });

  it("reads a timeout as 'could not ask', never as 'gone'", async () => {
    response = { kind: "fails", code: 1, stderr: "", killed: true };
    const answer = await psIdentify(1234);
    expect(answer.kind).toBe("unknown");
    if (answer.kind !== "unknown") return;
    expect(answer.reason).toMatch(/did not answer/);
  });

  it("reads an unparseable time as 'could not ask', never as 'gone'", async () => {
    response = { kind: "prints", stdout: "mer. 26 aout 19:52:19 2026" };
    expect((await psIdentify(1234)).kind).toBe("unknown");
  });

  /**
   * The reason is another program's stderr, and it reaches a terminal two ways: through a refusal,
   * and through the throw in `self()` when awcli cannot identify itself. One consumer sanitised it
   * and the other did not, which is an argument for doing it here — at the point the foreign string
   * enters awcli — rather than at each place it leaves.
   */
  it("does not carry what a terminal would act on out of ps's own output", async () => {
    response = {
      kind: "fails",
      code: 1,
      stderr: "ps: \u001b[2Junrecognized \u202eoption: o\n",
    };
    const answer = await psIdentify(1234);
    expect(answer.kind).toBe("unknown");
    if (answer.kind !== "unknown") return;
    expect(answer.reason).not.toContain("\u001b");
    expect(answer.reason).not.toContain("\u202e");
    expect(answer.reason).toContain("unrecognized");
  });

  /** And it does not carry a megabyte of it either: a refusal has its own explanation to deliver. */
  it("caps how much of a complaint a reason carries", async () => {
    response = { kind: "fails", code: 1, stderr: `ps: ${"x".repeat(5_000)}\n` };
    const answer = await psIdentify(1234);
    expect(answer.kind).toBe("unknown");
    if (answer.kind !== "unknown") return;
    expect(answer.reason.length).toBeLessThan(200);
  });
});
