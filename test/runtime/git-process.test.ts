import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_COMPLAINT_LIMIT,
  GIT_MAX_BUFFER,
  NO_COMPLAINT,
  createGitRunner,
  gitComplaint,
  systemGitRunner,
} from "../../src/runtime/git-process.js";

const execFileAsync = promisify(execFile);

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

  /**
   * A child killed by something that is not awcli's own timeout.
   *
   * `code` is null, `killed` is false, and the signal is the only thing in the error that says what
   * happened — so none of the branches above it matched and execFile's raw error was rethrown. What
   * an operator saw when the out-of-memory killer took `git worktree add` on a large repository was
   * `Command failed: git worktree add ...`, from the module whose stated job is telling its failures
   * apart. `sh` stands in for git for the same reason `head` does above: the runner is the one under
   * test, only the binary differs.
   */
  it("names the signal when something else kills git", async () => {
    const cwd = await directory();
    const killed = createGitRunner("sh");

    const thrown = await killed(["-c", "kill -TERM $$"], cwd).then(
      (outcome) => outcome,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("SIGTERM");
    expect(message).not.toMatch(/not installed|could not be run|did not finish within/);
  });

  /** A `cwd` that exists and is a file answers the same way: there is no directory to run in. */
  it("treats a file where a directory should be as no directory", async () => {
    const cwd = await directory();
    const file = join(cwd, "a-file");
    await writeFile(file, "not a directory\n", "utf8");
    expect((await systemGitRunner(["--version"], file)).kind).toBe("no-such-directory");
  });
});

/**
 * Every variable git reads that would send it somewhere other than the directory it was asked
 * about, or change its configuration on the way.
 *
 * Listed here as well as in the module because this is the half that has to be a list of names: the
 * assertion is that none of them survives into the child, and a test deriving the list from the
 * module's own would pass for an empty one.
 */
const REDIRECTING = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_PARAMETERS",
] as const;

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
 * What git is told about where the repository is, which `-C` and a `cwd` do not settle.
 *
 * git's discovery variables win over both: with `GIT_DIR` set, git operates on that repository from
 * any working directory at all, and `GIT_CONFIG_COUNT` injects configuration into every invocation.
 * awcli inherits its environment from whatever started it, and the things that start it include a
 * git hook, `git rebase --exec` and `git bisect run` — all of which set exactly these. So a run
 * launched from one repository would cut branches in another while every sentence awcli prints names
 * the one the operator asked for.
 */
describe("the environment a git child gets", () => {
  it("hands git none of the variables that would redirect it", async () => {
    const cwd = await directory();
    const planted = Object.fromEntries(REDIRECTING.map((name) => [name, "planted"]));

    const printed = await withEnvironment(planted, async () => {
      // `env` rather than git, because the assertion is about the child's environment itself: a
      // runner that stripped only the variables this suite happens to check would pass otherwise.
      const outcome = await createGitRunner("env")([], cwd);
      expect(outcome.kind).toBe("ran");
      return outcome.kind === "ran" ? outcome.stdout : "";
    });

    const names = printed
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("=")))
      .filter((name) => name.length > 0);
    for (const name of REDIRECTING) expect(names).not.toContain(name);
    // And the rest of the environment is still there: stripping is a subtraction, not a clean slate.
    // git needs PATH to find its own subcommands and HOME to find the operator's configuration.
    expect(names).toContain("PATH");
  });

  it("asks about the directory it was given, not the one GIT_DIR names", async () => {
    const repository = await directory();
    await execFileAsync("git", ["init", "-q", "-b", "main", "."], { cwd: repository });
    const elsewhere = await directory();

    const outcome = await withEnvironment(
      { GIT_DIR: join(repository, ".git") },
      async () => systemGitRunner(["rev-parse", "--git-dir"], elsewhere),
    );

    // Not a repository, which is the truth about `elsewhere`. With the variable inherited, git
    // answers 0 and names the *other* repository's git dir — so awcli's not-a-repository refusal is
    // unreachable and everything after it operates on a repository nobody asked about.
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.code).not.toBe(0);
    expect(outcome.stdout).not.toContain(repository);
  });

  it("does not let an inherited GIT_CONFIG_COUNT configure the git it runs", async () => {
    const repository = await directory();
    await execFileAsync("git", ["init", "-q", "-b", "main", "."], { cwd: repository });

    const outcome = await withEnvironment(
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "awcli.injected",
        GIT_CONFIG_VALUE_0: "yes",
      },
      async () => systemGitRunner(["config", "--get", "awcli.injected"], repository),
    );

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.stdout.trim()).toBe("");
    expect(outcome.code).not.toBe(0);
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
  });

  /**
   * git failing silently, which every caller puts after a full stop.
   *
   * The empty string here produced `... exited 128. ` in five thrown messages: a trailing space, no
   * cause, and a sentence that reads as truncated. Silence is an answer, so it is said.
   */
  it("says so when git printed nothing rather than answering with nothing", () => {
    expect(gitComplaint("   \n")).toBe(NO_COMPLAINT);
    expect(gitComplaint("")).toBe(NO_COMPLAINT);
    expect(`git exited 128. ${gitComplaint("")}`).not.toMatch(/\s$/);
  });

  /** Another program's output on its way to a terminal, so it goes through the sanitizer. */
  it("does not carry a terminal escape out of git's stderr", () => {
    const wiper = "fatal: \u001b[2Jwiped";
    expect(gitComplaint(wiper)).not.toContain("\u001b");
    expect(gitComplaint(wiper)).toContain("wiped");
    // Derived from the exported bound rather than from the number it currently holds — the sibling
    // constant's own docblock is about exactly this: a test that hard-codes it goes on passing when
    // the bound moves. The three are the ellipsis `printable` adds.
    expect(gitComplaint(`fatal: ${"x".repeat(500)}`)).toHaveLength(
      GIT_COMPLAINT_LIMIT + 3,
    );
  });
});
