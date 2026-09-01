import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll } from "vitest";
import { validateRunName, type RunName } from "../../src/runtime/run-identity.js";
import {
  resolveWorkspaceChoice,
  type WorkspaceChoice,
} from "../../src/runtime/workspace.js";

/**
 * Real git, against real repositories in a temp directory — the fixtures the workspace suites share.
 *
 * The scenarios are about what happens to an operator's checkout, and every one of the wrong
 * implementations worth testing — the default quietly using the live tree, a slot dropped from a
 * path, a provisioning that removes what is in its way — looks identical to the right one through a
 * mocked git. So the three BDD scenarios and every refusal that git itself decides run against the
 * real thing, as `run-lock.test.ts` runs against a real filesystem. The `GitRunner` seam is used
 * only for the faults no temp repository can stage: git absent from the machine, and git failing
 * for a reason awcli does not recognise.
 *
 * A module rather than a copy per file, because the suite is split across files for a reason that
 * has nothing to do with what it asserts: every mutation in `verify-workspace-gate.sh` runs the
 * whole thing, vitest parallelises across *files* and not within one, and one 1800-line file made
 * the gate a 20-minute job whose cost was already being traded against coverage (two mutations
 * declined outright for it). Splitting along the `describe` blocks puts the same assertions on
 * eleven cores. What must not be split is the setup: two copies of `repository()` drift, and the
 * drift is invisible because both copies still pass.
 *
 * The hooks below are registered at module scope on purpose. A `use…()` call each file has to
 * remember is a call a new file will not make, and the failure — a suite reading the developer's
 * own git configuration, or leaving temp repositories behind — is silent. Importing this module is
 * how a file gets `repository()`, so it cannot get the fixtures without also getting their cleanup.
 */
const execFileAsync = promisify(execFile);

const repositories: string[] = [];

/**
 * Git with nothing of the developer's own configuration in it, for the suite's own setup calls.
 *
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` reach the code under test as well, and that is the
 * correction: `gitEnvironment()` used to strip every `GIT_CONFIG*` variable, so this neutralisation
 * covered the tests' own `git()` helper and stopped at the seam — `systemGitRunner` handed the
 * developer's real `$HOME/.gitconfig` back to git. An operator with `status.showUntrackedFiles=no`
 * therefore ran a different `dirty()` from the one CI ran. git-process.ts now passes those two
 * through (it strips the *injectors* by name), so setting them process-wide below makes the git
 * under test hermetic too.
 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "awcli test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "awcli test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** The two the code under test reads, set for the length of the file and put back after it. */
const HERMETIC: readonly string[] = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"];
const inherited = new Map<string, string | undefined>();

beforeAll(() => {
  for (const name of HERMETIC) {
    inherited.set(name, process.env[name]);
    process.env[name] = "/dev/null";
  }
});

afterAll(() => {
  for (const [name, value] of inherited) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  inherited.clear();
});

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * A temp directory the `afterEach` above should remove, for a test that makes its own.
 *
 * Exported rather than the array itself: a test that pushed onto an exported array would still be
 * relying on this module's cleanup, and one that reassigned it would silently disable it.
 */
export function track(path: string): string {
  repositories.push(path);
  return path;
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
  });
  return stdout;
}

/**
 * An empty repository: initialised, no commit. There is no branch to cut from one of these.
 *
 * Canonicalised, because awcli asks git where the repository root is (`rev-parse --show-toplevel`)
 * and git answers canonically: on macOS the temp directory is `/var/folders/...`, a symlink to
 * `/private/var/folders/...`, and a test comparing awcli's answer against the uncanonicalised
 * spelling would be asserting which of the two names for one directory git happens to print.
 */
export async function bareStart(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "awcli-workspace-"));
  repositories.push(made);
  const path = await realpath(made);
  await git(path, "init", "-q", "-b", "main", ".");
  return path;
}

/**
 * A repository on `main` with one commit, an uncommitted change, and an untracked file.
 *
 * The uncommitted change is the point of the default scenario: it is what an operator loses if
 * awcli works in their checkout.
 */
export async function repository(): Promise<string> {
  const path = await bareStart();
  await writeFile(join(path, "file.txt"), "committed\n", "utf8");
  await git(path, "add", "-A");
  await git(path, "commit", "-qm", "first");
  await writeFile(join(path, "file.txt"), "committed\nuncommitted\n", "utf8");
  await writeFile(join(path, "scratch.txt"), "untracked\n", "utf8");
  return path;
}

/**
 * A repository whose path contains a space, for the remedies a refusal tells the operator to run.
 *
 * The space is in the *repository root* rather than in the temp template, because that is what
 * every `git worktree remove <path>` in a refusal interpolates: `<root>/.awcli/run/worktrees/...`.
 */
export async function repositoryWithASpaceInItsPath(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "awcli-workspace-spaced-"));
  repositories.push(parent);
  const path = join(await realpath(parent), "My Projects");
  await mkdir(path);
  await git(path, "init", "-q", "-b", "main", ".");
  await writeFile(join(path, "file.txt"), "committed\n", "utf8");
  await git(path, "add", "-A");
  await git(path, "commit", "-qm", "first");
  return path;
}

/** A directory that is not a repository at all. */
export async function notARepository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "awcli-workspace-plain-"));
  repositories.push(path);
  return path;
}

/** Through the validators, never a cast: a test that casts would pass with validation removed. */
export function runName(name: string): RunName {
  const result = validateRunName(name);
  if (!result.ok) throw new Error(`test used an invalid run name: ${result.message}`);
  return result.name;
}

export const TRIAGE = runName("triage");

/**
 * The operator's own consent, from the only thing that produces one.
 *
 * Narrowed on the way out, which is itself the assertion that the resolver honours the flag: a
 * resolver that answered `worktree` for `--live-checkout` would fail here rather than silently give
 * every live-checkout test a worktree to pass against.
 */
export function consented(): Extract<WorkspaceChoice, { workspace: "liveTree" }> {
  const choice = resolveWorkspaceChoice({ liveCheckout: true });
  if (choice.workspace !== "liveTree") {
    throw new Error("the resolver did not honour --live-checkout");
  }
  return choice;
}

/**
 * What the operator's working tree looks like, for a before-and-after comparison.
 *
 * `.git` is excluded and that exclusion is deliberate rather than convenient: `git worktree add`
 * writes its own bookkeeping under `.git/worktrees/`, which is git's administrative area and not
 * the operator's work. What the scenario promises is that nothing of *theirs* moved — their branch,
 * their files, and their uncommitted changes.
 *
 * `.awcli` is *not* excluded, and that is the correction. It was filtered from both the listing and
 * the status, which made "my uncommitted changes and current branch are untouched" an assertion
 * against a view that could not show the one thing provisioning does change: until AWCLI-22 writes
 * the ignore entry, a run leaves `?? .awcli/` in the operator's `git status`. The two exclusions
 * looked alike and are not — `.git` is git's own area, `.awcli` is awcli's untracked output in
 * somebody's repository — and the status filter was a substring match besides, so an operator's own
 * `notes.awcli.md` would have gone with it. The scenario asserts that entry positively instead, so
 * the day the ignore line lands this has to be updated rather than going on passing.
 */
export async function checkout(repositoryPath: string) {
  const entries = (await readdir(repositoryPath))
    .filter((entry) => entry !== ".git")
    .sort();
  const status = (await git(repositoryPath, "status", "--porcelain"))
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();
  return {
    entries,
    status,
    branch: (await git(repositoryPath, "branch", "--show-current")).trim(),
    head: (await git(repositoryPath, "rev-parse", "HEAD")).trim(),
    file: await readFile(join(repositoryPath, "file.txt"), "utf8"),
  };
}

export async function branchExists(
  repositoryPath: string,
  branch: string,
): Promise<boolean> {
  try {
    await git(repositoryPath, "rev-parse", "--verify", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a recorded git invocation is the provisioning add.
 *
 * By membership rather than by position: awcli prefixes the add with `-c core.hooksPath=...`, so a
 * matcher anchored at `args[0]` silently stops matching — which for the recording test below would
 * turn "no add was attempted" from an assertion into a tautology.
 */
export function isWorktreeAdd(args: readonly string[]): boolean {
  return args.includes("worktree") && args.includes("add");
}

/** Every branch in the repository, so a test can say that no *second* branch appeared. */
export async function branches(repositoryPath: string): Promise<readonly string[]> {
  const printed = await git(
    repositoryPath,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  );
  return printed
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();
}
