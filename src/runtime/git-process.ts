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
 * that hangs for ever on a git waiting for credentials or on a lock nothing is going to release, not
 * a slow checkout.
 *
 * One bound for all of them, and that is a decision that has been asked about twice, so here is the
 * measurement it turns on. The objection is that five of awcli's six invocations are metadata calls
 * costing tens of milliseconds, and that an operator meeting a stuck repository therefore waits two
 * minutes in silence at the *first* of them — the scenario named being a held `index.lock`. That
 * scenario does not occur. Measured on git 2.55 with `.git/index.lock` present and held:
 * `rev-parse --git-dir`, `rev-parse --show-toplevel`, `rev-parse --verify HEAD`,
 * `for-each-ref refs/heads`, `worktree list --porcelain`, `status --porcelain`, `branch <name>` and
 * `worktree add` each exited 0 in 63-103ms. A stale lock file makes git fail or proceed at once; it
 * does not make git wait.
 *
 * And the split a tighter bound would need does not fall where "metadata" suggests. `status
 * --porcelain` is one of the calls the objection classes as metadata, and it walks the whole working
 * tree — on a large repository it is legitimately among the slowest things awcli runs, and it is the
 * one call `dirty()` makes for the life of the run. Giving it a few seconds would turn a big
 * repository into a fault. So a second bound would have to be a per-argv policy table, which is more
 * surface than the residual justifies: what is actually left is that a git hung for some *other*
 * reason is noticed after two minutes rather than after ten seconds, and the operator seeing nothing
 * while it happens is a reporting question — AWCLI-21's — rather than a question about the bound.
 * Recorded rather than left to be re-raised a third time.
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
 * How much of a `cwd` these messages will show.
 *
 * `binary`, `args` and a signal name all go through `printable` here, and `cwd` did not — which left
 * the one value in the sentence that awcli did not construct as the one value not sanitised. It is a
 * directory path, and a directory name may hold any byte but NUL and `/`: `git rev-parse
 * --show-toplevel` hands the repository root back byte for byte, ESC and U+202E included, which
 * `workspace.ts` measures and states where it sanitises the same value for its own messages. Every
 * one of the three throws below reaches an operator's terminal, so an ESC in a repository's own
 * directory name repainted the line explaining why git had just been killed.
 *
 * A path's own limit rather than `PRINTABLE_LIMIT`, which is sized for a hostname: a repository root
 * truncated at 64 characters is not a path anybody can act on. This matches the bound `workspace.ts`
 * uses for the same value in a message.
 */
const CWD_LIMIT = 256;

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
  /**
   * git is *there* and could not be started for this call. The errno says why.
   *
   * Split out of `unavailable`, which every non-ENOENT spawn error used to fall into: a repository
   * directory at mode 000 fails `EACCES`, and the operator was told to install git and put it on the
   * PATH — advice that cannot work, about a machine where git is present and working. `EAGAIN` and
   * `EMFILE` from a loaded machine arrived the same way. Widening the `isDirectory` probe is not the
   * fix and cannot be: `stat` on a mode-000 directory succeeds, so the probe cannot tell this from a
   * directory that is simply there. The errno is the only thing that can, so it is carried out rather
   * than folded into a sentence.
   */
  | { readonly kind: "not-started"; readonly reason: string; readonly code: string }
  /** The directory git was to run in does not exist. Nothing was asked of git at all. */
  | { readonly kind: "no-such-directory"; readonly path: string };

/** The seam every git invocation goes through. Substituted in tests; the real one runs git. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitOutcome>;

/**
 * The variables awcli removes from a git child's environment, and what they have in common.
 *
 * Not "every one of these wins over `-C`", which is what this said: that is true of `GIT_DIR`,
 * `GIT_WORK_TREE` and `GIT_COMMON_DIR` and of nothing else here. The union is wider and weaker —
 * each of these redirects *something* git resolves for itself, in one of four directions:
 * which repository (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`), where its storage is
 * (`GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`), how refs and
 * discovery are scoped (`GIT_NAMESPACE`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`), and where git finds its
 * own subcommands (`GIT_EXEC_PATH`). Stating the strong property of the first three as the rule for
 * all nine invites the next maintainer to trim the six it does not describe.
 *
 * `GIT_EXEC_PATH` was missing from this list while the list's own rule described it exactly, and it is
 * the one with an execution consequence: it names the directory git resolves `git-<subcommand>` out
 * of, so an attacker-controlled directory means an executable of theirs runs with the operator's
 * identity. It is inert on this build and only because of what awcli happens to call — `rev-parse`,
 * `branch`, `worktree`, `for-each-ref` and `status` are all builtins, which `GIT_EXEC_PATH` cannot
 * reach. Measured on git 2.55: with a `git-worktree` script of my own on that path,
 * `GIT_EXEC_PATH=<dir> git worktree list` still ran the builtin. That is a fact about today's call
 * sites and not a property, which is the reason to strip it rather than to write the omission down as
 * reasoned: AWCLI-14 adds `ctx.git.log`, `.diff` and `.commit`, and a git that ever grows a
 * non-builtin here would inherit the hole silently.
 *
 * `GIT_CEILING_DIRECTORIES` was in this list and is not, and the reason is its own rather than the
 * one the `GIT_CONFIG` prefix scrub was unpicked for — that one was false and is retracted below,
 * where the two config variables are kept for a weaker reason stated as such. This variable really
 * does point the other way: it stops git walking up past the directories it names, so removing it
 * can only *widen* discovery — an operator who had fenced their tree off would have awcli find a
 * repository above the fence. Restricting is not redirecting, and `cwd` already pins the repository
 * awcli means, so it is passed through.
 *
 * None of them are exotic: git itself exports them, so anything running under a hook,
 * `git rebase --exec`, `git bisect run` or a filter has them set for every child it starts, awcli
 * included. Measured for the one that would be easiest to assume is not exported: a `post-checkout`
 * hook under git 2.55 printed `GIT_EXEC_PATH=[/opt/homebrew/opt/git/libexec/git-core]`. awcli has already decided which repository it means by the time it calls — it is the
 * `cwd` argument — and nothing in the environment may overrule it.
 */
const GIT_REDIRECTING_VARIABLES: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
];

/**
 * Configuration injected through the environment, which is arbitrary code by another route.
 *
 * `core.hooksPath` set this way is a checkout running whatever it names, so these go the same way as
 * the redirectors above. Named individually rather than caught by a `GIT_CONFIG` prefix, which is
 * what this used to do and which swept up two variables pointing the *other* way — see below.
 */
const GIT_CONFIG_INJECTORS: readonly string[] = [
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
];

/** `GIT_CONFIG_COUNT`'s numbered pairs, which have no fixed set of names. */
const GIT_CONFIG_INJECTOR_PREFIXES: readonly string[] = [
  "GIT_CONFIG_KEY_",
  "GIT_CONFIG_VALUE_",
];

/**
 * The environment a git child is given: this process's, minus the variables above.
 *
 * A subtraction rather than an allowlist. git legitimately reads a great deal of the environment —
 * `PATH` to find its own subcommands, `HOME` for the operator's configuration, the proxy and
 * credential variables — and a list of what to keep would be a list that goes stale silently, in the
 * direction of a git that behaves differently under awcli than in the operator's own shell.
 *
 * `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GIT_CEILING_DIRECTORIES` are passed through, and that
 * is a decision rather than an omission. The ceiling variable restricts where git may look rather
 * than redirecting it, so stripping it widens discovery; see the note on the list above.
 *
 * The two config variables are a different case, and the reason recorded for them was false — which
 * matters, because the reason is what a maintainer trims a list by. It said stripping them "is the
 * opposite of what either does", on the strength of one *use*: pointing them at `/dev/null` is the
 * standard way to run git without the operator's and the machine's configuration, and a
 * `name.startsWith("GIT_CONFIG")` rule silently undid the hardening of any caller, CI job or test
 * harness that had switched it off. That use is real and it is not what the variables are.
 * `GIT_CONFIG_GLOBAL=<file>` names a config file git then reads, so it *adds* configuration exactly
 * as `GIT_CONFIG_PARAMETERS` does. Measured on git 2.55:
 * `GIT_CONFIG_GLOBAL=<mine> git config --get core.hooksPath` printed my path, and a
 * `filter.<n>.smudge` supplied only through that variable executed during
 * `git -c core.hooksPath=/dev/null/... worktree add`. So the rule this list is sorted by — injecting
 * is stripped, restricting is passed through — does not separate these two from the three injectors
 * above them, and pretending it does invites the next maintainer to keep exactly the wrong one.
 *
 * They are preserved for a different and weaker reason, stated as such: awcli deliberately runs *the
 * operator's* git, and on this build the environment awcli was started with is a trusted input,
 * because anything able to set it already has execution on the host with the operator's identity.
 * `NO_HOOKS` survives them regardless, and that is a property rather than a hope — a command-line
 * `-c` outranks every config file, verified on the same run:
 * `GIT_CONFIG_GLOBAL=<mine> git -c core.hooksPath=/dev/null/awcli-runs-no-hooks config --get
 * core.hooksPath` printed awcli's value, not mine. Passing them through is the choice
 * that keeps awcli's git the same git the operator has — which is what AWCLI-14 needs, since a
 * commit reads `user.name` and `user.email` from exactly there — and it is what lets a suite pin the
 * configuration the code under test sees. It does not by itself make that suite hermetic: git resolves
 * `core.excludesFile` to `$XDG_CONFIG_HOME/git/ignore` by default and reads it whether or not the
 * global config file has been neutralised, so a suite that wants hermeticity pins `HOME` too — see
 * `git-hermetic.ts`, which is where that pinning lives and where a personal ignore entry was enough
 * to turn a scenario red. It sat in `workspace-support.ts` until the two concerns were split; a
 * suite that wants the hermeticity and not the repository fixtures imports the former alone. The other direction (pinning both to `/dev/null`) would make
 * provisioning reproducible and `ctx.git.commit()` authorless; this file picks the operator's git.
 *
 * Built per invocation rather than once, because `process.env` is mutable and a module-level copy
 * would answer a question about the moment this file was imported.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (
      GIT_REDIRECTING_VARIABLES.includes(name) ||
      GIT_CONFIG_INJECTORS.includes(name) ||
      GIT_CONFIG_INJECTOR_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      delete environment[name];
    }
  }
  // git's diagnostics are localised and this module *parses* them — `gitComplaint` picks the line
  // beginning `fatal:` or `error:`, and those prefixes are translated. Under `LC_ALL=de_DE.UTF-8`
  // git says `schwerwiegend:`, so the complaint quoted to the operator became the last line of
  // whatever git printed instead of the line that says what went wrong. The porcelain formats awcli
  // parses are stable by design; the prose beside them is not, and it is read too.
  //
  // Pinned on the child rather than asserted in the suite, because it is the *product* that reads
  // these strings — a suite pinned alone would go green on a machine where awcli was wrong. It also
  // fixes the gate's worst failure mode: with the suite already red for a locale, all 146
  // `expect_red` steps report `ok` for the wrong reason and the run only fails ~28 minutes later
  // with "it was already broken".
  //
  // `LC_ALL` because it wins over `LC_MESSAGES` and `LANG` both, and `LANGUAGE` because GNU gettext
  // consults it ahead of either — it is ignored while the locale is `C`, and cleared anyway so that
  // this does not rest on that. The operator still reads git's own words; they are just the
  // untranslated ones.
  environment.LC_ALL = "C";
  environment.LANGUAGE = "";
  return environment;
}

/**
 * A runner for a named binary, and optionally a shorter bound than the real one.
 *
 * Exported for the tests that cannot be written any other way, which is now two rather than one.
 * Proving that a machine with no git is reported as a machine with no git means running something
 * that is not there, and `systemGitRunner` hard-codes the name — the same reason `process-probe.ts`
 * exports `psIdentify`. Proving that a git which *hangs* is reported as one means waiting for the
 * bound, and `GIT_TIMEOUT_MS` is two minutes: the timeout branch below therefore had no test and no
 * gate anchor at all, on a module whose stated reason for existing is the three failures a real
 * repository cannot stage — and a hang is one of the three. `timeoutMs` is what makes it 50.
 *
 * Neither parameter is a configuration point, and awcli never calls this with anything but `git` and
 * the default bound.
 */
export function createGitRunner(binary: string, timeoutMs = GIT_TIMEOUT_MS): GitRunner {
  return async (args, cwd) => {
    try {
      const { stdout, stderr } = await execFileAsync(binary, [...args], {
        cwd,
        env: gitEnvironment(),
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return { kind: "ran", code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as {
        code?: string | number;
        killed?: boolean;
        signal?: string | null;
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
          `${printable(binary)} ${printable(args.join(" "))} printed more than ${GIT_MAX_BUFFER} bytes in ${printable(cwd, CWD_LIMIT)}, which is more than awcli reads from one git invocation.`,
          { cause: error },
        );
      }
      // A child killed by something that is not awcli. `code` is null, `killed` is false and the
      // signal is the only thing in the error that says what happened — so without this it fell past
      // every branch to the raw rethrow, and an OOM-killed `git worktree add` reached the operator
      // as execFile's own `Command failed: git ...` rather than the sentence awcli writes for a
      // provisioning that failed. This module's whole job is telling its failures apart.
      if (
        failure.killed !== true &&
        typeof failure.signal === "string" &&
        failure.signal.length > 0
      ) {
        throw new Error(
          `${printable(binary)} ${printable(args.join(" "))} was killed by ${printable(failure.signal)} in ${printable(cwd, CWD_LIMIT)}. Something outside awcli stopped it — the out-of-memory killer is the usual reason on a large repository.`,
          { cause: error },
        );
      }
      if (failure.killed === true) {
        throw new Error(
          `${printable(binary)} ${printable(args.join(" "))} did not finish within ${timeoutMs}ms in ${printable(cwd, CWD_LIMIT)}. Something is holding a git lock, or waiting for input awcli cannot give it.`,
          { cause: error },
        );
      }
      // Every other spawn errno. `ENOENT` is the missing binary and was answered above; what is
      // left is a git that exists and could not be started for this call — `EACCES` on a repository
      // directory the operator cannot enter, `EAGAIN` or `EMFILE` on a machine out of processes or
      // descriptors. All of these used to return `unavailable`, which `workspace.ts` renders as
      // "install git, or put it on the PATH": true for exactly one errno and misleading for the rest.
      if (typeof failure.code === "string") {
        return {
          kind: "not-started",
          code: failure.code,
          reason: `${printable(binary)} could not be started in ${printable(cwd, CWD_LIMIT)} (${printable(failure.code)})`,
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

/**
 * How much of git's own stderr a message repeats. Enough for the cause, not enough to bury it.
 *
 * `GIT_` in the name because `process-probe.ts` declares its own `COMPLAINT_LIMIT`, for the same
 * concept — how much of another program's stderr awcli quotes — at a different value (120, sized
 * for `ps`, which does not print paths). Two identical identifiers one file apart, with different
 * values and only one of them exported, is a reader assuming the wrong bound; the prefix is which
 * program's output it bounds.
 */
export const GIT_COMPLAINT_LIMIT = 200;

/**
 * What a message says when git failed and printed nothing at all.
 *
 * The empty string was the honest-looking answer and the wrong one: every caller interpolates this
 * after a full stop, so silence produced `... exited 128. ` — a trailing space and no cause, which
 * reads as a message that was cut off. Silence is an answer and this is it said out loud.
 */
export const NO_COMPLAINT = "git printed nothing.";

/**
 * The line of git's stderr that says what went wrong.
 *
 * Not the first line, which is what this was and which is wrong for the one command in awcli that
 * prints progress: `git worktree add` writes `Preparing worktree (checking out 'awcli/triage/main')`
 * before it fails, so taking the first line quoted the announcement and threw the cause away — on
 * the single path this module declares it cannot explain and therefore throws on, where the quoted
 * line *is* the whole of the remedy. Measured on git 2.55 under awcli's own argv — `worktree add
 * <target> <branch>`, into a directory with a file in it — two lines, that announcement and then
 * `fatal: 'occupied' already exists`, exit 128.
 *
 * The wording quoted here was `(new branch 'awcli/triage/main')` until the same measurement was
 * repeated, and that form is what `git worktree add -b` prints: awcli's argv stopped carrying `-b`
 * when the branch cut became a `git branch` of its own, so the module under review could no longer
 * emit the line its own docblock told a reader to look for. The general point — first line progress,
 * second line cause — is what the split did not change.
 *
 * So: the first line git marks as a complaint, and failing that the last non-empty one, which is
 * where a program that prints progress puts its verdict. Sanitised, because this is another
 * program's output on its way to a terminal.
 *
 * A git that printed nothing gets `NO_COMPLAINT` rather than the empty string, because every caller
 * interpolates this into a sentence after a full stop. See there.
 */
export function gitComplaint(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const marked = lines.find(
    (line) => line.startsWith("fatal:") || line.startsWith("error:"),
  );
  const line = marked ?? lines.at(-1);
  return line === undefined ? NO_COMPLAINT : printable(line, GIT_COMPLAINT_LIMIT);
}
