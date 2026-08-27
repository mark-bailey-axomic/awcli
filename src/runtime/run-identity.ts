import { basename, join } from "node:path";

/**
 * A run's name, and the paths that follow from it.
 *
 * The name is the isolation key for everything mutable a run owns: its state, its record, its
 * lock, and its worktrees and branches (BR-036). One run per name is what makes durable shared
 * state safe to write without coordination (ADR-0005, BR-010); differently named runs are
 * different writers and may proceed together (BR-011).
 *
 * Because the name reaches a directory path and a git branch, it is validated rather than
 * sanitised. An explicit `--name` is never rewritten to something legal: two operators' distinct
 * names could slugify to one, and two runs believing they hold different locks while sharing a
 * single lock file is the exact failure the lock exists to prevent. A default derived from a
 * workflow reference *is* slugified, because there the input was not a name the operator chose.
 */

/**
 * A run name that has been through `validateRunName`.
 *
 * Branded, so a raw string cannot reach a path or a lock. The alternative was a comment asking
 * call sites to validate first, and the review of the first version of this file found exactly
 * what that is worth: `acquireRunLock` took a bare string, so `"../../../etc"` escaped the runtime
 * directory and `""` collapsed every run onto one repository-wide lock. Neither is reachable now
 * without a deliberate cast.
 */
declare const runNameBrand: unique symbol;
export type RunName = string & { readonly [runNameBrand]: true };

/** The runtime directory, relative to the repository root. All mutable state lives here (BR-030). */
const RUNTIME_DIRECTORY = ".awcli";

/** Everything a run mutates sits under this, so one generated ignore line covers all of it. */
const RUN_DIRECTORY = "run";

/**
 * Names a run may not take, because something else already owns that path.
 *
 * `worktrees` is the live one: the layout puts working copies at `run/worktrees/<run>/<slot>`,
 * a sibling of `run/<run>/`, so a run called `worktrees` would have its state directory and the
 * worktree root be the same directory. Refusing the name is cheaper than moving the layout and
 * far cheaper than discovering the collision when a worktree lands on top of a state file.
 */
export const RESERVED_RUN_NAMES: readonly string[] = ["worktrees"];

/**
 * Long enough for a descriptive name, short enough that the branch and the worktree path built
 * from it stay inside the limits of every filesystem awcli runs on.
 */
const MAX_RUN_NAME_LENGTH = 64;

/**
 * Alphanumeric at both ends, dots, dashes and underscores inside.
 *
 * The ends are constrained because git's ref rules are: a component may not begin with a dot and
 * may not end with one. This does not cover git's third rule — a component may not end in `.lock`
 * — and the first version of this comment claimed it did: `k` is a letter, so `nightly.lock`
 * passed here and would have been refused later by git, at branch-creation time, after the run had
 * taken its lock and started work. That rule is checked explicitly below.
 *
 * Constraining the ends also keeps a name from looking like a shell option in a message.
 */
const RUN_NAME_PATTERN = /^[A-Za-z0-9]$|^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/;

/** Why a name was refused. Discriminated so the caller can say what to fix, not just that it is wrong. */
export type RunNameProblem =
  | "empty"
  | "too-long"
  | "illegal-characters"
  | "traversal"
  | "reserved"
  | "not-lowercase"
  | "git-reserved-suffix";

export interface RunNameRefusal {
  readonly ok: false;
  readonly name: string;
  readonly problem: RunNameProblem;
  /** Operator-facing, naming the thing to fix (the gate chain prints this verbatim). */
  readonly message: string;
}

export type RunNameResult =
  { readonly ok: true; readonly name: RunName } | RunNameRefusal;

/** Whether a string may be used as a run name, and why not when it may not. */
export function validateRunName(name: string): RunNameResult {
  if (name.length === 0) {
    return refuse(name, "empty", "A run name cannot be empty.");
  }
  if (name.length > MAX_RUN_NAME_LENGTH) {
    return refuse(
      name,
      "too-long",
      `A run name may be at most ${MAX_RUN_NAME_LENGTH} characters; this one is ${name.length}. It becomes a directory name and a branch name.`,
    );
  }
  // Before the character test, so `..` is reported as what it is rather than as a stray dot.
  // A name reaching a path join is the one illegal character class with a consequence outside
  // the run's own directory.
  if (name.includes("..")) {
    return refuse(
      name,
      "traversal",
      `A run name may not contain "..": it becomes a path under ${RUNTIME_DIRECTORY}/${RUN_DIRECTORY}/ and must stay inside it.`,
    );
  }
  if (!RUN_NAME_PATTERN.test(name)) {
    return refuse(
      name,
      "illegal-characters",
      `"${name}" is not usable as a run name. Use letters, digits, dots, dashes and underscores, starting and ending with a letter or digit — the name becomes a directory name and a git branch name.`,
    );
  }
  // Lowercase only. A run name is a directory on a filesystem that may be case-insensitive
  // (APFS, NTFS) and a git branch on one that is not, so `Triage` and `triage` would be one lock
  // file and two branches — a pair of runs that contend for state while diverging on disk.
  // Refused rather than lowercased, for the same reason no other name is rewritten.
  if (name !== name.toLowerCase()) {
    return refuse(
      name,
      "not-lowercase",
      `"${name}" must be lowercase: the name is both a directory (on a filesystem that may ignore case) and a git branch (on one that does not), and the two must agree. Try "${name.toLowerCase()}".`,
    );
  }
  // git refuses a ref component ending in `.lock`, and it refuses it at branch-creation time —
  // which is after this run has taken its lock and started work. The edge-character rule below
  // does not catch it, because `k` is a letter.
  if (name.endsWith(".lock")) {
    return refuse(
      name,
      "git-reserved-suffix",
      `A run name may not end in ".lock": git refuses a branch whose name ends that way, and the name becomes the branch awcli/${name}/<slot>.`,
    );
  }
  if (RESERVED_RUN_NAMES.includes(name)) {
    return refuse(
      name,
      "reserved",
      `"${name}" is reserved: awcli uses that path for the run's working copies. Choose another name.`,
    );
  }
  return { ok: true, name: name as RunName };
}

function refuse(name: string, problem: RunNameProblem, message: string): RunNameRefusal {
  return { ok: false, name, problem, message };
}

/**
 * The run name a workflow reference implies when the operator names none.
 *
 * Deterministic, and that is the point rather than a convenience: the same workflow invoked
 * twice must land on the same lock, or BR-010 would not catch the case it exists for — a
 * scheduled job firing while the operator is testing the same workflow by hand. A default
 * containing a timestamp or a random suffix would make every run a different writer and quietly
 * remove the guarantee.
 *
 * Slugified rather than validated, unlike an explicit name: the input here is a file path or a
 * library entry, not something the operator offered as an identifier, so rejecting
 * `./workflows/Nightly Triage.ts` for its space would be refusing a legal workflow over a
 * question nobody asked.
 */
export function defaultRunName(workflowReference: string): RunNameResult {
  const stem = basename(workflowReference).replace(/\.[cm]?[jt]s$/, "");
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    // Collapse, then strip the ends, so `--nightly--.ts` cannot produce a name the validator
    // would then reject for its edges — a default that can be refused is not a default.
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, MAX_RUN_NAME_LENGTH)
    .replace(/[^a-z0-9]+$/, "");

  if (slug.length === 0) {
    return refuse(
      workflowReference,
      "empty",
      `No run name could be derived from "${workflowReference}". Pass --name to say what this run is called.`,
    );
  }
  // Through the validator rather than trusting the slug: reserved names survive slugification
  // untouched, so `worktrees.ts` would otherwise become a legal-looking default that collides.
  const validated = validateRunName(slug);
  if (validated.ok) return validated;
  // But not with the validator's own message. Those are written for a name the operator typed, and
  // they end by telling them to choose another one — advice that makes no sense for a name nobody
  // chose. `./workflows/worktrees.ts` is a legal workflow reference, and being told that
  // "worktrees" is reserved and to pick something else is a puzzle rather than an instruction:
  // there is no `--name` on the command line to change. Review's point. The reason is kept, because
  // it is accurate and specific; what changes is whose mistake it says it is, and what to do.
  return {
    ok: false,
    name: workflowReference,
    problem: validated.problem,
    message: `awcli derived the run name "${slug}" from "${workflowReference}", and it cannot be used. ${validated.message} Pass --name to give this run a name of your own.`,
  };
}

export interface RunNameRequest {
  /**
   * `--name`, when the operator passed it. Wins outright.
   *
   * Absent and empty are different. `--name ""` is a mistake — a shell variable that did not
   * expand is the usual cause — and silently falling back to the derived default would send the
   * run at whatever the workflow file happens to be called, which is not what was asked for.
   */
  readonly explicit?: string | undefined;
  /** The workflow reference the command was given, used only when there is no explicit name. */
  readonly workflowReference: string;
}

/** The run name for this invocation: the explicit one if there is one, otherwise the derived one. */
export function resolveRunName(request: RunNameRequest): RunNameResult {
  const explicit = request.explicit;
  return explicit === undefined
    ? defaultRunName(request.workflowReference)
    : validateRunName(explicit);
}

/** `<repo>/.awcli/run` — the single ignored path (BR-030). */
export function runtimeRoot(repositoryPath: string): string {
  return join(repositoryPath, RUNTIME_DIRECTORY, RUN_DIRECTORY);
}

/**
 * `<repo>/.awcli/run/<run>` — one run's own directory: state, record, lock, logs.
 *
 * Not exported: nothing outside this module needs it yet. AWCLI-08's record and AWCLI-09's state
 * will, and can export it then — an export with no caller is a surface nobody has had to justify.
 */
function runDirectory(repositoryPath: string, runName: RunName): string {
  return join(runtimeRoot(repositoryPath), runName);
}

/**
 * The directories between the repository root and a run's own directory, outermost first.
 *
 * Derived from the same constants that build the lock's path, rather than by walking back up from
 * it. Walking up needs a stopping condition, and the obvious one — string equality against the
 * repository path — is wrong for any path that is the same directory spelled differently. Review
 * caught it: `--repo /repo/` (a trailing separator, which shell completion supplies) never matched
 * `/repo`, so the walk carried on past the repository and inspected `/repo` and `/`. Deriving the
 * list forwards has no stopping condition to get wrong.
 */
export function runDirectoryAncestors(
  repositoryPath: string,
  runName: RunName,
): readonly string[] {
  return [
    join(repositoryPath, RUNTIME_DIRECTORY),
    runtimeRoot(repositoryPath),
    runDirectory(repositoryPath, runName),
  ];
}

/** `<repo>/.awcli/run/<run>/lock` — the file whose existence means someone holds this name. */
export function runLockPath(repositoryPath: string, runName: RunName): string {
  return join(runDirectory(repositoryPath, runName), "lock");
}
