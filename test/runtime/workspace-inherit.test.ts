import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DisposalStack } from "../../src/runtime/disposal.js";
import { DEFAULT_SLOT, worktreePath } from "../../src/runtime/run-identity.js";
import {
  acquireWorkspace,
  resolveWorkspaceChoice,
  LIVE_CHECKOUT_FLAG,
  NO_HOOKS_PATH,
} from "../../src/runtime/workspace.js";
import {
  git,
  repository,
  branches,
  TRIAGE,
  consented,
  track,
} from "./workspace-support.js";

/**
 * What provisioning inherits, what it reports, and what it lets the operator's repository print.
 */
/**
 * What awcli's own git invocations inherit from the process that started awcli.
 *
 * Both of these are about provisioning being the one moment awcli acts on a repository with the
 * operator's identity and before anything of the run exists to contain it. The environment decides
 * *which* repository git acts on — `-C` and a working directory do not settle it — and a checkout
 * runs whatever `post-checkout` the repository carries.
 */
describe("what provisioning does not inherit", () => {
  /** Sets variables for the length of one call and puts the environment back however it ends. */
  async function withEnvironment<T>(
    variables: Readonly<Record<string, string>>,
    body: () => Promise<T>,
  ): Promise<T> {
    const before = new Map(
      Object.keys(variables).map((name) => [name, process.env[name]] as const),
    );
    Object.assign(process.env, variables);
    try {
      return await body();
    } finally {
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  /**
   * awcli run from somewhere that has already told git which repository to use.
   *
   * A git hook, `git rebase --exec` and `git bisect run` all export `GIT_DIR`, and git obeys it over
   * both the working directory and `-C`. Inherited, `git worktree add` cuts the branch and checks
   * the tree out in *that* repository while `WorkspaceHandle.dir`, the BR-015 sentence and every
   * refusal name the one the operator asked about. Reproduced on git 2.55 before this was written.
   */
  it("provisions in the repository it was given, not the one GIT_DIR names", async () => {
    const repositoryPath = await repository();
    const elsewhere = await repository();

    const outcome = await withEnvironment(
      {
        GIT_DIR: join(elsewhere, ".git"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.bare",
        GIT_CONFIG_VALUE_0: "false",
      },
      async () =>
        acquireWorkspace(new DisposalStack(), {
          repositoryPath,
          runName: TRIAGE,
          choice: resolveWorkspaceChoice({}),
        }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.workspace.dir).toBe(
      worktreePath(repositoryPath, TRIAGE, DEFAULT_SLOT),
    );
    // The repository awcli was pointed at got the branch and the working copy...
    expect(await branches(repositoryPath)).toEqual(["awcli/triage/main", "main"]);
    expect(existsSync(join(outcome.workspace.dir, ".git"))).toBe(true);
    // ...and the other one is exactly as it was: no branch of awcli's, nothing written into it.
    expect(await branches(elsewhere)).toEqual(["main"]);
    expect(existsSync(join(elsewhere, ".awcli"))).toBe(false);
  });

  /**
   * Every hook a provisioning could reach, one test per hook and one hook per mutating git call.
   *
   * Hooks resolve through the *common* git dir, which every worktree of a repository shares, so
   * these are not files the run's own working copy controls: an agent in one slot can write
   * `<repo>/.git/hooks/<name>` and the next acquisition — any run, any slot — executes it on the
   * host, before AWCLI-25's execution boundary exists to contain anything. Provisioning is awcli's
   * own step, so awcli says which hooks it runs: none. `describe` says so to the operator, in those
   * words, which is why this is a suite of hooks and not a suite of one.
   *
   * - `post-checkout` is the one this started as: `git worktree add` performs a checkout.
   * - `reference-transaction` is the one that arrived with the split of `git worktree add -b` into
   *   its own `git branch` (AWCLI-13 review round 3). Every ref update runs it, so it fires on the
   *   *first* mutating call of a provisioning rather than the second — strictly earlier than the
   *   checkout, and it was live for one commit because the split carried `NO_HOOKS` onto the add and
   *   not onto the branch. Verified against git 2.55: `git branch <name> <sha>` runs it, and the
   *   same call under awcli's `core.hooksPath` does not.
   */
  it.each([["post-checkout"], ["reference-transaction"]] as const)(
    "does not run the repository's %s hook while provisioning",
    async (name) => {
      const repositoryPath = await repository();
      const evidence = await mkdtemp(join(tmpdir(), "awcli-workspace-hook-"));
      track(evidence);
      const marker = join(evidence, `${name}-ran`);
      const hook = join(repositoryPath, ".git", "hooks", name);
      await mkdir(dirname(hook), { recursive: true });
      await writeFile(hook, `#!/bin/sh\necho ran >> "${marker}"\n`, "utf8");
      await chmod(hook, 0o755);

      const outcome = await acquireWorkspace(new DisposalStack(), {
        repositoryPath,
        runName: TRIAGE,
        choice: resolveWorkspaceChoice({}),
      });

      // The provisioning still succeeds — hooks are suppressed, not depended on.
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(existsSync(join(outcome.workspace.dir, ".git"))).toBe(true);
      expect(existsSync(marker)).toBe(false);
      // And the branch it says it cut is there: a hook suppressed by not making the ref at all
      // would satisfy the line above.
      expect(await branches(repositoryPath)).toEqual(["awcli/triage/main", "main"]);
    },
  );

  /**
   * `core.fsmonitor`, which `core.hooksPath` does not govern and which ran on the host.
   *
   * Not a hook, and that is the whole finding: git resolves `core.fsmonitor` as a command of its own,
   * from the *shared* `.git/config`, and pinning `core.hooksPath` does nothing to it. Measured on git
   * 2.55 with the hooks path pinned to exactly awcli's value, a marker script ran twice during
   * `-c status.showUntrackedFiles=normal status --porcelain` and twice again during
   * `git worktree add`.
   *
   * The exposure is worse than the hooks above rather than equal to them. An agent inside any slot
   * reaches the shared config with a plain `git config core.fsmonitor <cmd>` — no path knowledge, no
   * write to `.git/hooks` — and from then on every `dirty()` and every later provisioning, of any
   * run, executes it under the operator's identity. That is a command planted *inside* the boundary
   * and executed outside it, which is the BR-015 direction the module docblock says must never
   * happen, and while it was open `describe`'s "awcli ran none of the repository's git hooks" was
   * false in the way that matters.
   *
   * Both routes are exercised, because they are two argv and one could be fixed alone: the
   * provisioning, and then a `dirty()` on the handle it returned. Unlike the content filters, closing
   * this costs nothing — an fsmonitor is a performance cache and git falls back to scanning the
   * working tree — so the provisioning still has to succeed and `dirty()` still has to answer.
   */
  it("does not run the repository's core.fsmonitor, which is not a hook", async () => {
    const repositoryPath = await repository();
    const evidence = await mkdtemp(join(tmpdir(), "awcli-workspace-fsmonitor-"));
    track(evidence);
    const marker = join(evidence, "fsmonitor-ran");
    const payload = join(evidence, "payload.sh");
    // Exits non-zero, which is how a real fsmonitor declines to answer: git falls back to scanning
    // rather than failing, so a suppressed one and a declining one differ only in the marker.
    await writeFile(
      payload,
      ["#!/bin/sh", `echo ran >> "${marker}"`, "exit 1", ""].join("\n"),
      "utf8",
    );
    await chmod(payload, 0o755);
    await git(repositoryPath, "config", "core.fsmonitor", payload);

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Route one: the provisioning. It still succeeds, and the branch it cut is there — a provisioning
    // that failed would satisfy an absent marker for the wrong reason.
    expect(existsSync(join(outcome.workspace.dir, ".git"))).toBe(true);
    expect(await branches(repositoryPath)).toEqual(["awcli/triage/main", "main"]);
    expect(existsSync(marker)).toBe(false);

    // Route two: the handle, for the life of the run. `dirty()` runs `git status`, which is where the
    // measurement found it running twice.
    await writeFile(join(outcome.workspace.dir, "untracked"), "x", "utf8");
    expect(await outcome.workspace.dirty()).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  /**
   * The hook the *handle* could reach, which is a different exposure from the two above.
   *
   * They cover provisioning — one mutating call each, both of them over before an agent has run.
   * `dirty()` is a `WorkspaceHandle` member a workflow calls for the whole life of the run, and it
   * runs `git status`; `git status` writes the index whenever it has to refresh stat information,
   * and writing the index runs `post-index-change`. Resolved through the *shared* `.git/hooks` and
   * the shared config's `core.hooksPath`, exactly as the two above are — so this was a file any
   * agent in any slot could plant and then trigger itself, handed execution on the host with the
   * operator's identity, repeatedly, and after AWCLI-25's boundary is supposed to be what stands
   * between an agent and the host. It was the one git call in the module without `NO_HOOKS`, which
   * also made `describe`'s "awcli ran none of the repository's git hooks" false in the tense that
   * sentence is written in: it says *making it and reading it*.
   *
   * The refresh is what makes the hook reachable, so the test has to cause one rather than assume
   * it: a bare `git status` on a freshly checked-out tree has nothing to write. Writing the same
   * bytes back changes the stat information and not the size, which is what makes git re-hash the
   * path and then write the index — the same mechanism the clean-filter test below relies on, and
   * measured the same way on git 2.55.
   */
  it("does not run the repository's post-index-change hook when the handle is asked whether the working copy is dirty", async () => {
    const repositoryPath = await repository();
    const evidence = await mkdtemp(join(tmpdir(), "awcli-workspace-hook-"));
    track(evidence);
    const marker = join(evidence, "post-index-change-ran");
    const hook = join(repositoryPath, ".git", "hooks", "post-index-change");
    await mkdir(dirname(hook), { recursive: true });
    await writeFile(hook, `#!/bin/sh\necho ran >> "${marker}"\n`, "utf8");
    await chmod(hook, 0o755);

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const checkedOut = join(outcome.workspace.dir, "file.txt");
    await writeFile(checkedOut, await readFile(checkedOut, "utf8"), "utf8");

    // The answer is still the honest one — the hook is suppressed, not the question.
    expect(await outcome.workspace.dirty()).toBe(false);
    expect(existsSync(marker)).toBe(false);

    // And the refresh really did happen, so the silence above is a suppressed hook rather than a
    // `git status` that had no index to write. Without `NO_HOOKS` this same call fires it, measured
    // on git 2.55 under awcli's exact argv.
    await writeFile(checkedOut, await readFile(checkedOut, "utf8"), "utf8");
    expect(await git(outcome.workspace.dir, "status", "--porcelain")).toBe("");
    expect(existsSync(marker)).toBe(true);
  });

  /**
   * *Where* `core.hooksPath` points, which the hook tests above cannot see.
   *
   * They plant a hook at `<repo>/.git/hooks/<name>` and assert it does not run, and that is true of
   * any `hooksPath` with nothing in it — `/tmp/awcli-runs-no-hooks` included. So the half of
   * `NO_HOOKS` that carries a security property rather than a convenience had neither a test nor a
   * gate mutation: measured, the substitution to `/tmp` left all ten gate suites green. /tmp is
   * world-writable, so an agent in any slot could pre-create that directory with a `post-checkout` in
   * it and be handed execution on the host at the next provisioning, with the operator's identity and
   * before any execution boundary exists — the exact failure `NO_HOOKS` is there to prevent.
   *
   * The property is that nobody can create the directory, so the assertion is that `mkdir` of it
   * fails, with the errno named: `/dev/null` is a character device, so there is no directory for a
   * path beneath it to live in. Measured on this machine (macOS 26.5, Darwin 25.5): ENOTDIR, from
   * `mkdir -p` in a shell and from `fs/promises` with `recursive: true` alike. `recursive` is the
   * form asserted because it is the generous one — the non-recursive call would fail for the missing
   * parent whatever the leaf was, which would pass against `/tmp/awcli-runs-no-hooks` too and prove
   * nothing.
   *
   * Removed again if it somehow *was* created, so that a mutated gate run leaves nothing on the
   * machine — and the assertion is on the captured error rather than on the removal, or a `mkdir`
   * that failed for an unrelated reason would read as the property holding.
   */
  it("points core.hooksPath somewhere no agent can plant a hook", async () => {
    const attempt = await mkdir(NO_HOOKS_PATH, { recursive: true }).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (attempt === undefined) await rm(NO_HOOKS_PATH, { recursive: true, force: true });

    expect(attempt).toBeInstanceOf(Error);
    expect((attempt as { code?: unknown }).code).toBe("ENOTDIR");
    // Nothing here asserts that git is *given* this path, and it does not need to: `NO_HOOKS`
    // interpolates the same constant, so there is one spelling rather than a value the test reads
    // beside a value git gets. That the argument reaches the mutating calls is what the two hook
    // tests above assert, and three gate mutations — one per mutating call — are what keep it there.
  });
});

describe("what the isolation awcli reports says, and what it leaves to others", () => {
  /**
   * `WorkspaceIsolation` is one axis of two (ADR-0003), and the sentence has to stay inside it.
   *
   * The type's own docblock refuses to report an execution target, because no exec target exists on
   * this build and inventing one is the mis-statement BR-015 exists to prevent. The description then
   * made that claim in prose — the network and this machine's credentials named as reachable, which
   * are properties of running on the host. The BR-015 scenario wanting that sentence is scoped to an
   * agent *running without a container*; a worktree composed with one (AWCLI-19) would reuse this
   * description and tell the operator their credentials are reachable inside a container that blocks
   * them.
   */
  it.each([
    ["worktree", () => resolveWorkspaceChoice({})],
    ["liveTree", () => consented()],
  ] as const)("states the workspace axis and no more on %s", async (axis, choose) => {
    const repositoryPath = await repository();
    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: choose(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { description } = outcome.workspace.isolation;

    // What the axis does settle is said, in as many words.
    expect(description.toLowerCase()).toContain("uncommitted");
    // And where: the working copy and the branch the operator has to be able to go and look at,
    // which is the half of BR-015 a sentence can drop without any assertion noticing.
    expect(description).toContain(outcome.workspace.dir);
    expect(description).toContain(outcome.workspace.branch);
    // What it does not settle is not claimed. These are the execution axis's to state, wherever the
    // two are composed into the contract's `Isolation`.
    expect(description).not.toMatch(/network/i);
    expect(description).not.toMatch(/credential/i);
    expect(description).not.toMatch(/reachable/i);
    // And the clause that says so *to the operator*, which both arms carry and neither asserted: the
    // three negatives above hold the sentence to the workspace axis, and this is the sentence telling
    // the reader that the axis is not the other one. It deleted cleanly from both arms with all ten
    // suites green — so the promise the module is most careful about over-stating could quietly be
    // left to be read as a machine boundary, which is the mis-statement BR-015 exists to prevent.
    expect(description).toMatch(
      /settled by where this run executes, not by the working copy it was given/,
    );

    // Then the clauses that are this axis's whole answer, per axis. The worktree sentence had one
    // word of it asserted — "uncommitted" — so everything that bounds the promise could be deleted
    // with the suite green: the carve-out BR-030 exists for, the hooks clause the hook suite above
    // exists for, and the residual that clause carries. The live-checkout twin has had the flag
    // asserted since the scenario suite; this is the same treatment for the axis nobody watched.
    if (axis === "worktree") {
      expect(description).toMatch(/untouched/);
      expect(description).toMatch(/\.awcli\/run\//);
      expect(description).toMatch(/none of the repository's git hooks/);
      // The bound on that clause: `NO_HOOKS` buys no hook, not "no code from the repository".
      expect(description).toMatch(/content filter/);
      // And its *scope*, which is the half that was wrong: bounded to "a checkout", the clause named
      // the residual and then put it in the past. `dirty()` runs the `clean` half of the same driver
      // and is called for the life of the run — see the sibling test below, which runs it.
      expect(description).toMatch(/to make this working copy and to read it/);
      // And the worktree arm's own framing of the bound, which is the stronger half: the live-checkout
      // sentence has nothing to over-claim, while this one has just promised the operator's checkout
      // is untouched and has to say what that promise is *not*.
      expect(description).toMatch(/not a boundary around the machine/);
    } else {
      expect(description).toContain(LIVE_CHECKOUT_FLAG);
    }
  });
});

describe("what the operator's own repository is allowed to put in a message", () => {
  /**
   * A branch name carrying a right-to-left override, on the live checkout.
   *
   * Of the *non-printing* characters git's ref rules ban only the C0 controls and DEL — git bans
   * plenty besides, as `openLiveTree` enumerates, and none of those renders as nothing. So the
   * bidirectional format characters are legal in a ref, verified: `git checkout -b` accepts one and
   * `branch --show-current` answers it back verbatim. That value went into the BR-015 sentence
   * unfiltered, so the line the operator read was not the line awcli emitted: everything after the
   * override renders reversed.
   *
   * Sanitising it on the way *into the handle* was the first fix and it was one layer too early,
   * which is what this now pins. `WorkspaceHandle.branch` is the contract field AWCLI-14 reattaches
   * by and BR-025 records the run against, and `printable` substitutes `?` for every character it
   * takes out — so on this repository the handle named a branch that does not exist, and the
   * assertion that it was sanitised was an assertion that it was wrong. The split the refusal path
   * already makes is the right one: `branchCollision` compares raw refs and `short` sanitises for the
   * sentence. So the field is asserted against git — the name it reports must resolve — and the
   * sentence is asserted to be safe.
   */
  it("keeps a hostile branch name usable on the handle and safe in what it prints", async () => {
    const repositoryPath = await repository();
    const hostile = "main\u202egnitset-elbuort";
    await git(repositoryPath, "checkout", "-q", "-b", hostile);

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: consented(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The field is the real ref, and git is what says so: a sanitised one would name a branch that
    // does not exist, and every consumer of the field resolves it rather than reading it.
    expect(outcome.workspace.branch).toBe(hostile);
    expect(
      (
        await git(
          repositoryPath,
          "rev-parse",
          "--verify",
          `refs/heads/${outcome.workspace.branch}`,
        )
      ).trim(),
    ).toBe((await git(repositoryPath, "rev-parse", "HEAD")).trim());
    // And the sentence is where it is made safe.
    expect(outcome.workspace.isolation.description).not.toContain("\u202e");
    // Still recognisable: what is removed is what a terminal renders differently, not the name.
    expect(outcome.workspace.isolation.description).toContain("main");
  });

  /**
   * A repository directory name carrying an escape sequence, which is the wider of the two channels
   * the same sentence interpolates.
   *
   * The remediation that sanitised the branch left `dir` raw beside it, and `dir` is the value that
   * can carry more: a git ref cannot hold a C0 control — `git check-ref-format` refuses
   * `refs/heads/a<ESC>b`, measured on git 2.55 — while a directory name may hold any byte but NUL
   * and `/`, and `git rev-parse --show-toplevel` hands the path back byte for byte, which this test
   * relies on and asserts. So the string an operator always reads had its narrower interpolation
   * hardened and its wider one open, on the success path, unbounded in length.
   *
   * `WorkspaceHandle.dir` stays the real path for the same reason `branch` does: `ctx.fs` and
   * `ctx.exec` resolve against it.
   */
  it("does not carry an escape sequence out of the repository path into what it prints", async () => {
    const parent = track(await mkdtemp(join(tmpdir(), "awcli-workspace-esc-")));
    const repositoryPath = join(await realpath(parent), "repo\u001b[2Kevil");
    await mkdir(repositoryPath);
    await git(repositoryPath, "init", "-q", "-b", "main", ".");
    await writeFile(join(repositoryPath, "file.txt"), "committed\n", "utf8");
    await git(repositoryPath, "add", "-A");
    await git(repositoryPath, "commit", "-qm", "first");

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // git handed the path back as it is, which is the premise: nothing upstream bounded it.
    expect((await git(repositoryPath, "rev-parse", "--show-toplevel")).trim()).toContain(
      "\u001b",
    );
    expect(outcome.workspace.dir).toContain("\u001b");
    // And the sentence does not.
    expect(outcome.workspace.isolation.description).not.toContain("\u001b");
    expect(outcome.workspace.isolation.description).toContain("repo?[2Kevil");
    // The handle still points at the working copy that exists, escape and all.
    expect(existsSync(join(outcome.workspace.dir, ".git"))).toBe(true);
  });
});
/**
 * What the handle's two questions inherit from the operator's own git configuration.
 */
describe("what the handle's answers do not inherit", () => {
  /**
   * `dirty()` under `status.showUntrackedFiles=no`, which is a common setting on a large repository.
   *
   * With it, `git status --porcelain` says nothing about untracked files at all — and `dirty()` is
   * documented as "whether it has uncommitted changes, what a resumed run would inherit", which an
   * untracked file certainly is. So on that operator's machine the answer was silently a different
   * answer from the one CI gives, and the parallel-agents scenario's `expect(await first.dirty())` was
   * asserting a property of the developer's `~/.gitconfig` as much as of the code. Pinned on the
   * invocation the way `NO_HOOKS` pins `core.hooksPath`; everything else the operator's configuration
   * says about `status` is still theirs to say.
   *
   * Set in the repository's own config rather than a global one, because that is the scope a worktree
   * shares — and because the suite already neutralises the global one, which would make this test
   * pass for the wrong reason.
   */
  it("reports an untracked file as dirty even when the repository has status.showUntrackedFiles off", async () => {
    const repositoryPath = await repository();
    await git(repositoryPath, "config", "status.showUntrackedFiles", "no");

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(await outcome.workspace.dirty()).toBe(false);
    await writeFile(join(outcome.workspace.dir, "new.txt"), "untracked\n", "utf8");
    expect(await outcome.workspace.dirty()).toBe(true);
  });

  /**
   * The residual the BR-015 sentence names, run rather than described: `dirty()` executes a command
   * the repository configured, on every call, for the whole life of the run.
   *
   * The module's security analysis had this as `core.fsmonitor`, which is a second route and not the
   * one. `git status` runs `filter.<driver>.clean` for every path `.gitattributes` assigns to a
   * driver whose stat information has changed, and the driver's command is a shell string read from
   * the *same* shared `.git/config` an agent in any slot can write — no path knowledge, no operator
   * setting anyone would notice. `NO_HOOKS` does not touch it: `core.hooksPath` governs hooks and
   * says nothing about filters.
   *
   * Which makes *when* it applies the part worth asserting. A smudge filter is one command at
   * provisioning, before any agent has run; this one is available on every question awcli asks about
   * the working copy afterwards, which is what the operator sentence now says and what this holds it
   * to. It is left open deliberately — see the module header for the two reasons and for the
   * requirement it puts on AWCLI-19 — so this test asserts that the residual exists, not that it is
   * closed. If a later change closes it, this test is the one that has to be rewritten with it.
   */
  it("runs a repository-configured clean filter on every dirty() call, which is the residual it reports", async () => {
    const repositoryPath = await repository();
    const marker = join(repositoryPath, "filter-ran.txt");
    await writeFile(
      join(repositoryPath, ".gitattributes"),
      "file.txt filter=probe\n",
      "utf8",
    );
    await git(repositoryPath, "add", "-A");
    await git(repositoryPath, "commit", "-qm", "attributes");
    // Written into the repository's own config, which is the scope every worktree shares — the same
    // scope, and the same one-line command, an agent in any slot reaches with `git config`.
    await git(repositoryPath, "config", "filter.probe.clean", `tee -a ${marker}`);

    const outcome = await acquireWorkspace(new DisposalStack(), {
      repositoryPath,
      runName: TRIAGE,
      choice: resolveWorkspaceChoice({}),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(existsSync(marker)).toBe(false);

    // The same bytes written back, so the stat information changes and the size does not: that is
    // what makes git re-hash the path rather than deciding it is modified from the size alone, and
    // re-hashing is what runs the filter. Measured that way on git 2.55 with `touch`.
    const checkedOut = join(outcome.workspace.dir, "file.txt");
    await writeFile(checkedOut, await readFile(checkedOut, "utf8"), "utf8");
    expect(await outcome.workspace.dirty()).toBe(false);

    expect(existsSync(marker)).toBe(true);
    // And the sentence the operator reads says so, in the tense that matches: not "a checkout ran
    // one", which is what it said while this call was executing one for the life of the run.
    expect(outcome.workspace.isolation.description).toContain(
      "to make this working copy and to read it",
    );
  });
});
