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

/** The runtime directory, relative to the repository root. All mutable state lives here (BR-030). */
export const RUNTIME_DIRECTORY = ".awcli";

/** Everything a run mutates sits under this, so one generated ignore line covers all of it. */
export const RUN_DIRECTORY = "run";

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
 * The ends are constrained because git's ref rules are: a component may not begin with a dot,
 * may not end with `.lock`, and may not end with a dot. Requiring alphanumeric at both ends
 * satisfies all three at once without enumerating them, and it also keeps a name from looking
 * like a shell option when it appears in a message.
 */
const RUN_NAME_PATTERN = /^[A-Za-z0-9]$|^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/;

/** Why a name was refused. Discriminated so the caller can say what to fix, not just that it is wrong. */
export type RunNameProblem =
  "empty" | "too-long" | "illegal-characters" | "traversal" | "reserved";

export interface RunNameRefusal {
  readonly ok: false;
  readonly name: string;
  readonly problem: RunNameProblem;
  /** Operator-facing, naming the thing to fix (the gate chain prints this verbatim). */
  readonly message: string;
}

export type RunNameResult = { readonly ok: true; readonly name: string } | RunNameRefusal;

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
  if (RESERVED_RUN_NAMES.includes(name)) {
    return refuse(
      name,
      "reserved",
      `"${name}" is reserved: awcli uses that path for the run's working copies. Choose another name.`,
    );
  }
  return { ok: true, name };
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
  return validateRunName(slug);
}

export interface RunNameRequest {
  /** `--name`, when the operator passed it. Wins outright. */
  readonly explicit?: string | undefined;
  /** The workflow reference the command was given, used only when there is no explicit name. */
  readonly workflowReference: string;
}

/** The run name for this invocation: the explicit one if there is one, otherwise the derived one. */
export function resolveRunName(request: RunNameRequest): RunNameResult {
  const explicit = request.explicit;
  return explicit === undefined || explicit.length === 0
    ? defaultRunName(request.workflowReference)
    : validateRunName(explicit);
}

/** `<repo>/.awcli/run` — the single ignored path (BR-030). */
export function runtimeRoot(repositoryPath: string): string {
  return join(repositoryPath, RUNTIME_DIRECTORY, RUN_DIRECTORY);
}

/** `<repo>/.awcli/run/<run>` — one run's own directory: state, record, lock, logs. */
export function runDirectory(repositoryPath: string, runName: string): string {
  return join(runtimeRoot(repositoryPath), runName);
}

/** `<repo>/.awcli/run/<run>/lock` — the file whose existence means someone holds this name. */
export function runLockPath(repositoryPath: string, runName: string): string {
  return join(runDirectory(repositoryPath, runName), "lock");
}
