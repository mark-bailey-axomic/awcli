import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { printable } from "./printable.js";

/**
 * Running git as a subprocess: spawning it, bounding it, and telling its failures apart.
 *
 * A port, on the `process-probe.ts` precedent, and for the same three reasons that file gives for
 * asking the operating system about a process behind one. The failures that matter cannot be staged
 * against a real repository — git missing from the machine, a git that hangs, a `cwd` that is not
 * there — and they are the ones where a caller either refuses when it should throw or throws when it
 * should refuse. They also need testing without a repository at all, which a module fused into
 * `workspace.ts` cannot offer. And AWCLI-14 needs the same thing next: `ctx.git.log`, `.diff` and
 * `.commit` are more git invocations, and a second copy of the classification below is a second copy
 * that will drift from this one.
 *
 * What lives here is *the process*, not what any answer means. This module says whether git ran and
 * what it printed; whether an exit status is a refusal an operator can fix or a fault they cannot is
 * the caller's question, and `workspace.ts` answers it.
 */

const execFileAsync = promisify(execFile);

/**
 * How long any one git invocation may take.
 *
 * Provisioning is required to cost a bounded amount of time, and `git worktree add` on a large
 * repository is the call that does real work. Generous rather than tight: what this prevents is a run
 * that hangs for ever on a git waiting for an index lock or for credentials, not a slow checkout.
 */
export const GIT_TIMEOUT_MS = 120_000;

/**
 * Enough for `git status --porcelain` in a large tree; the answer is only read for emptiness.
 *
 * Exported because the message for exceeding it names it, and a test that hard-coded the number
 * would go on passing if the bound moved.
 */
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * What running git produced.
 *
 * Three kinds rather than two, because the third was a lie the first version told. `execFile` raises
 * ENOENT both for a binary it cannot find and for a `cwd` that does not exist, and mapping ENOENT
 * straight to "git is not installed" sent an operator who mistyped `--repo` to install git on a
 * machine that already had it — while making the "not a repository" refusal unreachable by that
 * route entirely. The two are distinguished here, at the only point where the errno and the
 * directory are both in hand.
 */
export type GitOutcome =
  | {
      readonly kind: "ran";
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  /** git could not be started: not installed, or not on the PATH awcli was given. */
  | { readonly kind: "unavailable"; readonly reason: string }
  /** The directory git was to run in does not exist. Nothing was asked of git at all. */
  | { readonly kind: "no-such-directory"; readonly path: string };

/** The seam every git invocation goes through. Substituted in tests; the real one runs git. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitOutcome>;

/**
 * A runner for a named binary.
 *
 * Exported for the one test that cannot be written any other way: proving that a machine with no git
 * is reported as a machine with no git means running something that is not there, and `systemGitRunner`
 * hard-codes the name — the same reason `process-probe.ts` exports `psIdentify`. It is not a
 * configuration point, and awcli never calls it with anything but `git`.
 */
export function createGitRunner(binary: string): GitRunner {
  return async (args, cwd) => {
    try {
      const { stdout, stderr } = await execFileAsync(binary, [...args], {
        cwd,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return { kind: "ran", code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as {
        code?: string | number;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };
      // A number is an exit status: git ran and answered. A string is an errno from the spawn.
      if (typeof failure.code === "number") {
        return {
          kind: "ran",
          code: failure.code,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
        };
      }
      // Before the errno is mapped to anything, because ENOENT alone cannot say which of the two it
      // is — the message is `spawn git ENOENT` for both, so there is nothing in the error to read.
      // ENOTDIR is the same question answered about a `cwd` that exists and is a file.
      if (failure.code === "ENOENT" || failure.code === "ENOTDIR") {
        if (!(await isDirectory(cwd))) return { kind: "no-such-directory", path: cwd };
      }
      if (failure.code === "ENOENT") {
        return {
          kind: "unavailable",
          reason: `${printable(binary)} is not installed, or not on the PATH`,
        };
      }
      // Before the generic string-errno branch below, which this used to fall through: exceeding
      // `maxBuffer` gives the *string* `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` with `killed` undefined,
      // so it came back as `unavailable` and `workspace.ts` turned that into "git has gone missing
      // while the run was starting" — for a `git status --porcelain` on a working copy with more
      // than GIT_MAX_BUFFER to say, which is neither true nor actionable. Thrown, like the timeout
      // below it: both are bounds awcli imposes on git rather than anything the operator chose, and
      // an operator who reads the size can tell which bound they met.
      if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new Error(
          `${printable(binary)} ${printable(args.join(" "))} printed more than ${GIT_MAX_BUFFER} bytes in ${cwd}, which is more than awcli reads from one git invocation.`,
          { cause: error },
        );
      }
      if (failure.killed === true) {
        throw new Error(
          `${printable(binary)} ${printable(args.join(" "))} did not finish within ${GIT_TIMEOUT_MS}ms in ${cwd}. Something is holding a git lock, or waiting for input awcli cannot give it.`,
          { cause: error },
        );
      }
      // EACCES on the binary, EAGAIN from fork on a loaded machine: git could not be started, and
      // that is not this repository's fault. Reported as unavailable so a refusal names the machine.
      if (typeof failure.code === "string") {
        return {
          kind: "unavailable",
          reason: `${printable(binary)} could not be run (${printable(failure.code)})`,
        };
      }
      throw error;
    }
  };
}

/** The real runner. */
export const systemGitRunner: GitRunner = createGitRunner("git");

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** How much of git's own stderr a message repeats. Enough for the cause, not enough to bury it. */
export const COMPLAINT_LIMIT = 200;

/**
 * The line of git's stderr that says what went wrong.
 *
 * Not the first line, which is what this was and which is wrong for the one command in awcli that
 * prints progress: `git worktree add` writes `Preparing worktree (new branch 'awcli/triage/main')`
 * before it fails, so taking the first line quoted the announcement and threw the cause away — on
 * the single path this module declares it cannot explain and therefore throws on, where the quoted
 * line *is* the whole of the remedy. Verified against git 2.55: two lines, the second beginning
 * `fatal:`.
 *
 * So: the first line git marks as a complaint, and failing that the last non-empty one, which is
 * where a program that prints progress puts its verdict. Sanitised, because this is another
 * program's output on its way to a terminal.
 */
export function gitComplaint(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const marked = lines.find(
    (line) => line.startsWith("fatal:") || line.startsWith("error:"),
  );
  return printable(marked ?? lines.at(-1) ?? "", COMPLAINT_LIMIT);
}
