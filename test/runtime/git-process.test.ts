import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_MAX_BUFFER,
  createGitRunner,
  gitComplaint,
  systemGitRunner,
} from "../../src/runtime/git-process.js";

/**
 * The git process port, tested without a workspace in sight.
 *
 * Which is the point of it being a port: these are the answers `workspace.ts` classifies into
 * refusals and faults, and two of them — a machine with no git, a `cwd` that is not there — cannot be
 * staged from a repository at all. They were fused into `workspace.ts` and therefore only ever
 * exercised through a provisioning, which is how a mapping that reported a mistyped `--repo` as "git
 * is not installed" stayed green.
 *
 * The timeout has no test here. Proving it fires means waiting out GIT_TIMEOUT_MS, and making it
 * injectable to avoid that would add a configuration point nothing needs — the same trade
 * `process-probe.ts` makes for its own bound.
 */
const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "awcli-git-process-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("running git", () => {
  it("answers with what git printed when it succeeds", async () => {
    const cwd = await directory();
    const outcome = await systemGitRunner(["--version"], cwd);
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toMatch(/^git version /);
  });

  /**
   * A non-zero exit is an answer, not a failure. Every refusal in `workspace.ts` is decided from one,
   * so a runner that threw here would turn each of them into a fault.
   */
  it("answers with the exit status and stderr when git complains", async () => {
    const cwd = await directory();
    const outcome = await systemGitRunner(["rev-parse", "--git-dir"], cwd);
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain("not a git repository");
  });

  /**
   * The two ENOENTs, which is the finding this module was extracted around.
   *
   * `execFile` raises ENOENT both for a binary it cannot find and for a `cwd` that does not exist,
   * with the same `spawn git ENOENT` message for both — verified. Mapping it unconditionally to "git
   * is not installed" sent an operator who mistyped `--repo` to install git on a machine that had it,
   * and made the not-a-repository refusal unreachable by that route.
   */
  it("tells a missing directory from a missing git", async () => {
    const missing = join(await directory(), "nowhere", "at", "all");
    const absent = await systemGitRunner(["--version"], missing);
    expect(absent.kind).toBe("no-such-directory");
    if (absent.kind === "no-such-directory") expect(absent.path).toBe(missing);

    const cwd = await directory();
    const noBinary = await createGitRunner("awcli-definitely-not-git")(
      ["--version"],
      cwd,
    );
    expect(noBinary.kind).toBe("unavailable");
    if (noBinary.kind !== "unavailable") return;
    expect(noBinary.reason).toContain("awcli-definitely-not-git");
    expect(noBinary.reason).toContain("PATH");
  });

  /**
   * More output than awcli reads, which is a bound this module imposes rather than a missing git.
   *
   * Exceeding `maxBuffer` gives `err.code` the *string* `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` with
   * `killed` undefined — verified — so it used to fall through the generic string-errno branch and
   * come back as `unavailable`. `workspace.ts` turns that into "git has gone missing while the run
   * was starting", which is neither true nor actionable for a `git status --porcelain` on a working
   * copy with more than sixteen megabytes to say. Thrown, and naming the limit, like the timeout
   * beside it: both are awcli's own bounds and neither is a choice the operator can make differently.
   *
   * `head` stands in for git because producing that much output from git means a repository this
   * suite has no business building. The runner is the same one; only the binary differs, which is
   * what `createGitRunner` is exported for.
   */
  it("names an answer too large to read rather than reporting a missing git", async () => {
    const cwd = await directory();
    const flood = createGitRunner("head");

    const thrown = await flood(
      ["-c", String(GIT_MAX_BUFFER + 1024 * 1024), "/dev/zero"],
      cwd,
    ).then(
      (outcome) => outcome,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain(String(GIT_MAX_BUFFER));
    expect(message).not.toMatch(/not installed|could not be run/);
  });

  /** A `cwd` that exists and is a file answers the same way: there is no directory to run in. */
  it("treats a file where a directory should be as no directory", async () => {
    const cwd = await directory();
    const file = join(cwd, "a-file");
    await writeFile(file, "not a directory\n", "utf8");
    expect((await systemGitRunner(["--version"], file)).kind).toBe("no-such-directory");
  });
});

describe("what git said went wrong", () => {
  /**
   * The line carrying the cause, which for the one command that prints progress is not the first one.
   * `git worktree add` writes `Preparing worktree (...)` and then fails, so the first line is the
   * announcement — and the message quoting it is the whole remedy on a path awcli throws from.
   */
  it("quotes the complaint rather than the progress line before it", () => {
    const stderr =
      "Preparing worktree (new branch 'awcli/triage/main')\nfatal: a branch named 'awcli/triage/main' already exists\n";
    expect(gitComplaint(stderr)).toBe(
      "fatal: a branch named 'awcli/triage/main' already exists",
    );
    expect(gitComplaint(stderr)).not.toContain("Preparing worktree");
  });

  it("takes an error: line as readily as a fatal: one", () => {
    expect(gitComplaint("Preparing\nerror: something\nmore\n")).toBe("error: something");
  });

  /** Nothing marked: the last non-empty line, which is where a program that prints progress ends. */
  it("falls back to the last line git printed", () => {
    expect(gitComplaint("first\nsecond\n\n")).toBe("second");
    expect(gitComplaint("   \n")).toBe("");
    expect(gitComplaint("")).toBe("");
  });

  /** Another program's output on its way to a terminal, so it goes through the sanitizer. */
  it("does not carry a terminal escape out of git's stderr", () => {
    const wiper = "fatal: \u001b[2Jwiped";
    expect(gitComplaint(wiper)).not.toContain("\u001b");
    expect(gitComplaint(wiper)).toContain("wiped");
    expect(gitComplaint(`fatal: ${"x".repeat(500)}`)).toHaveLength(203);
  });
});
