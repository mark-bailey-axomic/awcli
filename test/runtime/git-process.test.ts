import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
 * The timeout is tested here too, which it was not while proving it fired meant waiting out
 * GIT_TIMEOUT_MS: `createGitRunner` takes the bound as a defaulted parameter, so the test below
 * builds one with 50ms and a `sh` that sleeps. The configuration point that trade was declining is a
 * default argument, and it bought the branch a test and a gate anchor.
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

  /**
   * A git that hangs — the second of the three failures this module says it exists for.
   *
   * It was the one with neither a test nor a gate anchor, because `GIT_TIMEOUT_MS` is two minutes and
   * nothing could wait for it. What that cost is not hypothetical: with the branch removed, a
   * timed-out child has `code === null`, so the string-errno branch does not match either and the
   * error falls all the way to the bare rethrow — `Command failed: sh -c sleep 5`, which is exactly
   * the outcome the sibling signal branch above was added to prevent. `worktreeRegistration`'s
   * `.catch(() => undefined)` in workspace.ts also exists to absorb this throw, so the behaviour it
   * guards against was itself unproven.
   *
   * The bound is a parameter for this test and nothing else; the message is asserted to name the
   * value passed rather than the constant, so a runner that timed out on its own default would fail
   * here instead of quietly agreeing.
   */
  it("names the bound when git does not finish inside it", async () => {
    const cwd = await directory();
    const impatient = createGitRunner("sh", 50);

    const thrown = await impatient(["-c", "sleep 5"], cwd).then(
      (outcome) => outcome,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("did not finish within 50ms");
    expect(message).not.toContain("Command failed");
    expect(message).not.toMatch(/not installed|could not be run|was killed by/);
  });

  /**
   * The `cwd` in these three messages is the one value in them awcli did not construct.
   *
   * `binary`, the argv and a signal name all went through `printable` and the directory did not, so
   * the sentence hardened everything except the part that came from outside: a directory name may
   * hold any byte but NUL and `/`, and `git rev-parse --show-toplevel` — which is where
   * `workspace.ts` gets the value it passes here — hands the repository root back byte for byte. An
   * ESC in it repaints the terminal line explaining why git had just been killed, and a U+202E
   * reverses the rest of it. Sanitising by delegation is not sanitising, which is what this holds.
   *
   * Both of the throwing branches are checked, because the fix was three interpolations and a test on
   * one of them proves nothing about the other two. The escape is asserted absent by code point
   * rather than by rendering, and the `?` is asserted present so that a bound that merely truncated
   * the path away would not pass.
   */
  it("does not carry a terminal escape out of a repository's own directory name", async () => {
    const parent = await directory();
    const hostile = join(parent, "repo-\u001b-and-\u202e");
    await mkdir(hostile);

    const impatient = createGitRunner("sh", 50);
    const timedOut = await impatient(["-c", "sleep 5"], hostile).then(
      (outcome) => outcome,
      (error: unknown) => error,
    );
    const killed = createGitRunner("sh");
    const signalled = await killed(["-c", "kill -TERM $$"], hostile).then(
      (outcome) => outcome,
      (error: unknown) => error,
    );

    for (const thrown of [timedOut, signalled]) {
      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : "";
      expect(message).not.toContain("\u001b");
      expect(message).not.toContain("\u202e");
      expect(message).toContain("?");
    }
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
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  // Where git resolves `git-<subcommand>`, so a directory an attacker controls is an executable of
  // theirs running with the operator's identity. It was missing from the module's list and from
  // this one while the module's own stated rule described it exactly. Inert today only because
  // every command awcli runs is a builtin, which this variable cannot reach — measured on git 2.55
  // with a `git-worktree` script of my own on that path, where `git worktree list` still ran the
  // builtin. A fact about today's call sites, and AWCLI-14 adds more of them.
  "GIT_EXEC_PATH",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_PARAMETERS",
] as const;

/**
 * The three that were being stripped and should not be.
 *
 * `GIT_CEILING_DIRECTORIES` belongs here on the list's own rule: it stops git walking up past the
 * directories it names, so stripping it lets awcli's git discover a repository *above* the one the
 * operator's environment had fenced off. Restricting is not redirecting.
 *
 * The two config variables do not, and the reason recorded for them was false — corrected in the
 * module and corrected here, because a reason restated in two files is what a maintainer trims a
 * list by. `GIT_CONFIG_GLOBAL=<file>` names a config file git then reads, so it *injects*
 * configuration exactly as `GIT_CONFIG_PARAMETERS` does: measured on git 2.55, it set
 * `core.hooksPath` and a `filter.<n>.smudge` supplied only through it executed during a
 * `worktree add`. What is true is the narrower thing: `/dev/null` in either is how a caller runs git
 * *without* the operator's or the machine's configuration, so a `startsWith("GIT_CONFIG")` rule
 * undid a hardening the caller had asked for and made this very suite non-hermetic about the code
 * under test while looking hermetic. They are passed through because awcli deliberately runs the
 * operator's git and the environment awcli was started with is a trusted input on this build — not
 * because they cannot inject. Asserted positively, because a decision to pass something through is
 * only a decision if something watches it.
 */
const PASSED_THROUGH = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CEILING_DIRECTORIES",
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
 * The strongest of them win over both: with `GIT_DIR` set, git operates on that repository from any
 * working directory at all, and `GIT_CONFIG_COUNT` injects configuration into every invocation. The
 * rest of the stripped list redirects storage or ref scoping rather than which repository — see
 * `GIT_REDIRECTING_VARIABLES` for the union, which is wider than the `GIT_DIR` property alone.
 * awcli inherits its environment from whatever started it, and the things that start it include a
 * git hook, `git rebase --exec` and `git bisect run` — all of which set exactly these. So a run
 * launched from one repository would cut branches in another while every sentence awcli prints names
 * the one the operator asked for.
 */
describe("the environment a git child gets", () => {
  it("hands git none of the variables that would redirect it", async () => {
    const cwd = await directory();
    const planted = Object.fromEntries(
      [...REDIRECTING, ...PASSED_THROUGH].map((name) => [name, "planted"]),
    );

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
    for (const name of PASSED_THROUGH) expect(names).toContain(name);
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
   * The empty string here produced `... exited 128. ` wherever a caller interpolates this after a
   * full stop: a trailing space, no cause, and a sentence that reads as truncated. Silence is an
   * answer, so it is said. No count of the call sites, deliberately — the one written here was five
   * and went stale within the same branch when the root lookup added more, which is the argument the
   * docblock below already makes about hard-coded bounds.
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
