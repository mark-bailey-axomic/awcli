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

      // A control, because without one this test would pass just as happily against a listener
      // that never fires — the failure mode a test asserting an empty array is most prone to.
      //
      // Emitted rather than floated. An earlier version created a genuine unhandled rejection
      // here, which works but leaves a runner-dependent hazard in the suite: some vitest
      // configurations treat any unhandled rejection as a hard file-level failure, and a test
      // that guards against flakiness has no business being a source of it. What this needs to
      // prove is only that the listener is attached and recording, and emitting the event
      // proves exactly that. Whether Node delivers a real one is Node's contract, not a thing
      // this suite has to re-establish.
      process.emit(
        "unhandledRejection",
        new Error("control: nothing is handling me"),
        Promise.resolve(),
      );

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

  it("releases a resource whose opening finished after the unwind started, and reports it", async () => {
    const log = recorder();
    const stack = new DisposalStack();
    await stack.acquire(log.resource("lock"));

    let finishOpening!: () => void;
    const slow = stack.acquire({
      name: "worktree",
      open: () =>
        new Promise<string>((resolve) => {
          finishOpening = () => resolve("worktree");
        }),
      release: () => void log.released.push("worktree"),
    });

    const unwinding = stack.unwind();
    finishOpening();

    await expect(slow).rejects.toBeInstanceOf(DisposalClosedError);
    const report = await unwinding;

    // Refused, but not stranded, and not silently dropped either: it was acquired last, so it
    // is released first, and it says so in the report the caller is handed.
    expect(log.released).toEqual(["worktree", "lock"]);
    expect(report.ok).toBe(true);
    expect(report.released.map((r) => r.name)).toEqual(["worktree", "lock"]);
    expect(stack.leaks()).toEqual([]);
  });

  it("does not report cleanup complete while an acquisition is still in flight", async () => {
    const stack = new DisposalStack();
    let finishOpening!: () => void;
    let releaseSeen = false;

    void stack
      .acquire({
        name: "container",
        open: () =>
          new Promise<string>((resolve) => {
            finishOpening = () => resolve("container");
          }),
        release: () => void (releaseSeen = true),
      })
      .catch(() => undefined);

    let unwound = false;
    const unwinding = stack.unwind().then((report) => {
      unwound = true;
      return report;
    });

    // Several turns of the loop: long enough that an unwind which ignored the in-flight
    // acquisition would have finished by now.
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    expect(unwound).toBe(false);

    finishOpening();
    const report = await unwinding;

    expect(releaseSeen).toBe(true);
    expect(report.released.map((r) => r.name)).toEqual(["container"]);
  });

  it("gives up on an acquisition that never opens, and reports it as stranded", async () => {
    const log = recorder();
    const stack = new DisposalStack(QUICK);
    await stack.acquire(log.resource("lock"));
    void stack
      .acquire({
        name: "wedged worktree",
        open: () => new Promise<string>(() => undefined),
        release: () => void log.released.push("wedged worktree"),
      })
      .catch(() => undefined);

    const report = await stack.unwind();

    expect(report.ok).toBe(false);
    expect(report.failures.map((f) => [f.name, f.reason])).toEqual([
      ["wedged worktree", "stranded"],
    ]);
    // The bound is what makes this finish at all, and the rest of the stack still came down.
    expect(log.released).toEqual(["lock"]);
    // Nothing to release and possibly something on disk: that is a leak and must be named.
    expect(stack.leaks()).toContain("wedged worktree");
  });

  it("releases a resource that arrives after the unwind has already finished", async () => {
    const log = recorder();
    const stack = new DisposalStack(QUICK);
    let finishOpening!: () => void;
    const slow = stack.acquire({
      name: "late worktree",
      open: () =>
        new Promise<string>((resolve) => {
          finishOpening = () => resolve("late worktree");
        }),
      release: () => void log.released.push("late worktree"),
    });

    // Times out waiting, reports it stranded, and finishes.
    await stack.unwind();
    expect(log.released).toEqual([]);

    finishOpening();
    await expect(slow).rejects.toBeInstanceOf(DisposalClosedError);

    // Nobody was left to release it, so acquire does — the report already said it was stranded,
    // which was true when it was written and is the honest thing to have told the caller.
    expect(log.released).toEqual(["late worktree"]);
    // And it stops being a leak. It was released; a check that kept naming it would be crying
    // wolf at whatever reads this next.
    expect(stack.leaks()).toEqual([]);
  });

  it("still releases an acquisition it gave up on, if it lands while the unwind is draining", async () => {
    const log = recorder();
    const stack = new DisposalStack(QUICK);

    // A release the test controls, so the drain is provably still running when the straggler
    // lands. It resolves well inside the bound once let go.
    let letLockGo: (() => void) | undefined;
    await stack.acquire({
      name: "lock",
      open: () => "lock",
      release: () =>
        new Promise<void>((resolve) => {
          letLockGo = () => {
            log.released.push("lock");
            resolve();
          };
        }),
    });

    let finishOpening!: () => void;
    const straggler = stack.acquire({
      name: "slow worktree",
      open: () =>
        new Promise<string>((resolve) => {
          finishOpening = () => resolve("slow worktree");
        }),
      release: () => void log.released.push("slow worktree"),
    });

    const unwinding = stack.unwind();

    // Past the bound, so the straggler has been given up on, and into the drain, which is now
    // sitting on the lock's release.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(letLockGo).toBeDefined();

    finishOpening();
    await expect(straggler).rejects.toBeInstanceOf(DisposalClosedError);
    letLockGo?.();

    const report = await unwinding;

    // Reverse order is over what is holdable at the time, which is the only reading that
    // survives a resource arriving after its turn has passed.
    expect(log.released).toEqual(["lock", "slow worktree"]);
    // The stranded verdict is withdrawn: it was a statement about what was known then, and what
    // is known now is that the resource was released.
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.released.map((r) => r.name)).toEqual(["lock", "slow worktree"]);
    expect(stack.leaks()).toEqual([]);
  });

  it("does not count an acquisition whose open threw as a leak", async () => {
    const stack = new DisposalStack();
    const boom = new Error("git worktree add failed");

    await expect(
      stack.acquire({
        name: "worktree",
        open: () => {
          throw boom;
        },
        release: () => undefined,
      }),
    ).rejects.toBe(boom);

    // Nothing was acquired, so there is nothing to release and nothing to warn about.
    expect(stack.leaks()).toEqual([]);
    expect((await stack.unwind()).ok).toBe(true);
  });
});
