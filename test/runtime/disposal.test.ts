import { describe, expect, it } from "vitest";
import {
  DisposalClosedError,
  DisposalStack,
  withDisposal,
  type Disposition,
  type UnwindReport,
} from "../../src/runtime/disposal.js";

/**
 * A tiny bound, so a test that proves a hung release is abandoned finishes in milliseconds
 * rather than in the ten seconds a real run allows. This is the whole reason the bound is an
 * option and not a constant.
 */
const QUICK = { releaseTimeoutMs: 20 };

/** Records the order releases actually happened in, which is what most of these assert. */
function recorder() {
  const released: string[] = [];
  return {
    released,
    resource(name: string, release?: () => void | Promise<void>) {
      return {
        name,
        open: () => name,
        release: async () => {
          await release?.();
          released.push(name);
        },
      };
    },
  };
}

async function acquireThree(stack: DisposalStack, log: ReturnType<typeof recorder>) {
  await stack.acquire(log.resource("lock"));
  await stack.acquire(log.resource("worktree"));
  await stack.acquire(log.resource("container"));
}

describe("unwinding in reverse on every exit path", () => {
  it("releases in reverse order of acquisition when the body ends normally", async () => {
    const log = recorder();
    const outcome = await withDisposal(async (stack) => {
      await acquireThree(stack, log);
      return "done";
    });

    expect(log.released).toEqual(["container", "worktree", "lock"]);
    expect(outcome.result).toEqual({ ok: true, value: "done" });
    expect(outcome.unwind.released.map((r) => r.name)).toEqual([
      "container",
      "worktree",
      "lock",
    ]);
  });

  it("releases in reverse order when the body reports a failure", async () => {
    const log = recorder();
    const outcome = await withDisposal(async (stack) => {
      await acquireThree(stack, log);
      return { failed: true };
    });

    expect(log.released).toEqual(["container", "worktree", "lock"]);
    expect(outcome.result).toEqual({ ok: true, value: { failed: true } });
    expect(outcome.unwind.ok).toBe(true);
  });

  it("releases in reverse order when the body throws", async () => {
    const log = recorder();
    const boom = new Error("the workflow body crashed");
    const outcome = await withDisposal(async (stack) => {
      await acquireThree(stack, log);
      throw boom;
    });

    expect(log.released).toEqual(["container", "worktree", "lock"]);
    // The body's error survives the unwind — cleanup does not get to replace it.
    expect(outcome.result).toEqual({ ok: false, error: boom });
  });

  it("unwinds on demand, which is the seam an interrupt will use", async () => {
    const log = recorder();
    const stack = new DisposalStack();
    await acquireThree(stack, log);

    const report = await stack.unwind();

    expect(log.released).toEqual(["container", "worktree", "lock"]);
    expect(report.ok).toBe(true);
  });
});

describe("a failing release does not stop the rest", () => {
  it("continues past a failure and reports every failure, not the first", async () => {
    const log = recorder();
    const first = new Error("lock file is gone");
    const second = new Error("container is already dead");

    const outcome = await withDisposal(async (stack) => {
      await stack.acquire(
        log.resource("lock", () => {
          throw first;
        }),
      );
      await stack.acquire(log.resource("worktree"));
      await stack.acquire(
        log.resource("container", () => {
          throw second;
        }),
      );
    });

    // The one release that could succeed still ran, even though it sat between two failures.
    expect(log.released).toEqual(["worktree"]);
    expect(outcome.unwind.ok).toBe(false);
    expect(outcome.unwind.failures).toEqual([
      { name: "container", reason: "threw", cause: second },
      { name: "lock", reason: "threw", cause: first },
    ]);
  });

  it("reports a rejected release as well as a thrown one", async () => {
    const stack = new DisposalStack();
    const cause = new Error("docker daemon not responding");
    await stack.acquire({
      name: "container",
      open: () => "container",
      release: () => Promise.reject(cause),
    });

    const report = await stack.unwind();

    expect(report.failures).toEqual([{ name: "container", reason: "threw", cause }]);
  });
});

describe("the leak check", () => {
  it("reports nothing leaked after a normal end, a failure, and a throw", async () => {
    const paths: Array<() => Promise<unknown>> = [
      async () => "finished",
      async () => ({ failed: true }),
      async () => {
        throw new Error("crashed");
      },
    ];

    for (const path of paths) {
      const log = recorder();
      // withDisposal owns the stack, and the question is what is left after it has finished
      // with it — so the body hands the stack back out to be asked afterwards.
      let stack: DisposalStack | undefined;
      await withDisposal(async (acquired) => {
        stack = acquired;
        await acquireThree(acquired, log);
        return path();
      });

      expect(stack?.leaks()).toEqual([]);
      expect(log.released).toEqual(["container", "worktree", "lock"]);
    }
  });

  it("fails when a resource is never released, which is what makes it a check", async () => {
    const stack = new DisposalStack();
    await stack.acquire({
      name: "run lock",
      open: () => "lock",
      release: () => undefined,
    });

    // No unwind. This is the leak the mechanism exists to prevent, and the check has to see it.
    expect(stack.leaks()).toEqual(["run lock"]);
  });

  it("counts a release that threw as still leaked, because nobody knows if it let go", async () => {
    const stack = new DisposalStack();
    await stack.acquire({
      name: "container",
      open: () => "container",
      release: () => {
        throw new Error("rm failed");
      },
    });

    await stack.unwind();

    expect(stack.leaks()).toEqual(["container"]);
  });

  it("counts an abandoned release as leaked", async () => {
    const stack = new DisposalStack(QUICK);
    await stack.acquire({
      name: "wedged container",
      open: () => "container",
      release: () => new Promise<void>(() => undefined),
    });

    await stack.unwind();

    expect(stack.leaks()).toEqual(["wedged container"]);
  });
});

describe("a release that never returns", () => {
  it("is abandoned after the bounded wait and reported as such", async () => {
    const log = recorder();
    const stack = new DisposalStack(QUICK);
    await stack.acquire(log.resource("lock"));
    await stack.acquire({
      name: "wedged container",
      open: () => "container",
      release: () => new Promise<void>(() => undefined),
    });

    const report = await stack.unwind();

    expect(report.ok).toBe(false);
    expect(report.failures.map((f) => [f.name, f.reason])).toEqual([
      ["wedged container", "abandoned"],
    ]);
    expect(String((report.failures[0] as { cause: unknown }).cause)).toContain("20ms");
    // The bound exists so the rest of the unwind still happens. It did.
    expect(log.released).toEqual(["lock"]);
  });

  it("does not let the abandoned release's later rejection escape", async () => {
    const escaped: unknown[] = [];
    const capture = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", capture);
    try {
      const stack = new DisposalStack(QUICK);
      await stack.acquire({
        name: "wedged container",
        open: () => "container",
        release: () =>
          new Promise<void>((_resolve, reject) =>
            setTimeout(() => reject(new Error("rm failed, eventually")), 40),
          ),
      });

      await stack.unwind();

      // A control rejection, floated in the same window with nothing watching it. Without it
      // this test would pass just as happily against a listener that never fires — which is
      // the failure mode a test asserting an empty array is most prone to.
      void Promise.reject(new Error("control: nothing is handling me"));

      // Past the point the abandoned release rejects, plus a turn for Node to decide which
      // rejections went unhandled.
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      process.off("unhandledRejection", capture);
    }

    expect(escaped.map(String)).toEqual(["Error: control: nothing is handling me"]);
  });
});

describe("release with preservation", () => {
  it("lets a resource go without destroying what it holds, and says so in the report", async () => {
    const seen: Array<[string, Disposition]> = [];
    const stack = new DisposalStack();
    await stack.acquire({
      name: "run lock",
      open: () => "lock",
      release: (r, d) => void seen.push([r, d]),
    });
    await stack.acquire({
      name: "worktree",
      open: () => "worktree",
      disposition: "preserve",
      release: (r, d) => void seen.push([r, d]),
    });

    const report = await stack.unwind();

    // BR-021, asserted rather than described: the lock goes, the worktree stays on disk.
    expect(seen).toEqual([
      ["worktree", "preserve"],
      ["lock", "destroy"],
    ]);
    expect(report.released).toEqual([
      { name: "worktree", disposition: "preserve" },
      { name: "run lock", disposition: "destroy" },
    ]);
  });
});

describe("unwinding more than once", () => {
  it("releases each resource exactly once when unwound twice", async () => {
    const log = recorder();
    const stack = new DisposalStack();
    await acquireThree(stack, log);

    const first = await stack.unwind();
    const second = await stack.unwind();

    expect(log.released).toEqual(["container", "worktree", "lock"]);
    expect(second).toBe(first);
  });

  it("releases each resource exactly once when unwound concurrently", async () => {
    const log = recorder();
    const stack = new DisposalStack();
    await acquireThree(stack, log);

    const reports: UnwindReport[] = await Promise.all([stack.unwind(), stack.unwind()]);

    expect(log.released).toEqual(["container", "worktree", "lock"]);
    expect(reports[0]).toBe(reports[1]);
  });
});

describe("acquiring once the stack is unwinding", () => {
  it("refuses, and refuses before opening anything", async () => {
    let opened = false;
    const stack = new DisposalStack();
    await stack.unwind();

    await expect(
      stack.acquire({
        name: "worktree",
        open: () => {
          opened = true;
          return "worktree";
        },
        release: () => undefined,
      }),
    ).rejects.toBeInstanceOf(DisposalClosedError);
    expect(opened).toBe(false);
    expect(stack.leaks()).toEqual([]);
  });

  it("releases a resource whose opening finished after the unwind started", async () => {
    const log = recorder();
    const stack = new DisposalStack();
    let finishOpening!: () => void;
    const slow = stack.acquire({
      name: "worktree",
      open: () =>
        new Promise<string>((resolve) => {
          finishOpening = () => resolve("worktree");
        }),
      release: () => void log.released.push("worktree"),
    });

    const unwound = stack.unwind();
    finishOpening();

    await expect(slow).rejects.toBeInstanceOf(DisposalClosedError);
    await unwound;
    // Refused, but not stranded: the resource was real by the time it arrived.
    expect(log.released).toEqual(["worktree"]);
    expect(stack.leaks()).toEqual([]);
  });
});
