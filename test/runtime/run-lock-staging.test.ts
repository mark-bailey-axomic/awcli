import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The one failure `run-lock.test.ts` cannot stage with a real filesystem.
 *
 * A write that fails *part-way through* — ENOSPC, EIO — leaves the staging file created and
 * unwritten, and there is no portable way to fill a disk or fault a device from a test. So this file
 * substitutes the one call, and only for the duration of the assertion. It lives apart from the main
 * lock suite because the module mock is hoisted over the whole file, and the rest of that suite must
 * run against a real filesystem or it proves nothing.
 */

/** Set by a test to make the next staging write create its file and then fail. */
let failNextWrite: { readonly code: string } | undefined;

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    writeFile: async (
      file: Parameters<typeof real.writeFile>[0],
      data: Parameters<typeof real.writeFile>[1],
      options?: Parameters<typeof real.writeFile>[2],
    ) => {
      const failure = failNextWrite;
      if (failure === undefined) return real.writeFile(file, data, options);
      failNextWrite = undefined;
      // Create the file, as the real `wx` open would, then fail as a mid-write error does.
      await real.writeFile(file, "", { flag: "wx", mode: 0o600 });
      throw Object.assign(new Error(`simulated ${failure.code}`), { code: failure.code });
    },
  };
});

const { DisposalStack } = await import("../../src/runtime/disposal.js");
const { runLockPath, validateRunName } =
  await import("../../src/runtime/run-identity.js");
const { acquireRunLock } = await import("../../src/runtime/run-lock.js");

const repositories: string[] = [];
afterEach(async () => {
  failNextWrite = undefined;
  await Promise.all(
    repositories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function runName(name: string) {
  const result = validateRunName(name);
  if (!result.ok) throw new Error(result.message);
  return result.name;
}

describe("a staging write that fails part-way through", () => {
  it("leaves no staging file behind, and reports the failure", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "awcli-staging-"));
    repositories.push(repositoryPath);
    const triage = runName("triage");
    const runDirectory = dirname(runLockPath(repositoryPath, triage));

    failNextWrite = { code: "ENOSPC" };

    await expect(
      acquireRunLock(new DisposalStack(), {
        repositoryPath,
        runName: triage,
        probe: {
          self: () => Promise.resolve({ pid: 4242, startedAt: 1_700_000_000_000 }),
          identify: () => Promise.resolve({ kind: "not-found" as const }),
        },
      }),
    ).rejects.toThrow(/ENOSPC/);

    // The whole point: nothing accumulates in the run's directory for someone to puzzle over later.
    expect(await readdir(runDirectory)).toEqual([]);
  });
});
