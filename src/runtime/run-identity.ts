import { basename, join } from "node:path";
import { printable } from "./printable.js";

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

/**
 * A slot's name, which has been through `validateSlotName`.
 *
 * Branded for the same reason `RunName` is, and the reason is sharper here: a slot arrives from a
 * *workflow* (`SandboxOptions.name`), so it is not even something the operator typed, and it reaches
 * a filesystem path and a git ref just as a run name does. `../../etc` as a slot is a traversal out
 * of the runtime directory and an illegal ref at once. The brand is what stops a raw string from a
 * workflow reaching `worktreePath` or `workspaceBranch` without the rules having been applied.
 */
declare const slotNameBrand: unique symbol;
export type SlotName = string & { readonly [slotNameBrand]: true };

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
 *
 * One limit for both a run name and a slot, because the two are concatenated into one path and one
 * ref: `run/worktrees/<run>/<slot>` and `awcli/<run>/<slot>`. Giving the slot its own, larger limit
 * would be a second number to keep in step with the same filesystem ceiling.
 */
const MAX_NAME_LENGTH = 64;

/**
 * Alphanumeric at both ends, dots, dashes and underscores inside.
 *
 * The leading end is constrained because git's ref rules are: no component of a refname may begin
 * with a dot. The trailing end is not that rule — git's ban on a trailing dot is on the *refname*,
 * so it binds the slot and not the run name, which never sits last: verified on git 2.55, which
 * accepts `refs/heads/awcli/nightly./main` and refuses `refs/heads/awcli/nightly/main.`. What
 * constrains this end is the legibility rule at the foot of this docblock. Nor does this pattern
 * cover git's `.lock` rule — a component may not end in `.lock`.
 * `k` is a letter, so `nightly.lock` satisfies this pattern and would be refused later by git, at
 * branch-creation time, after the run had taken its lock and started work. That rule is checked
 * explicitly below, and not by this.
 *
 * Constraining the ends also keeps a name from looking like a shell option in a message.
 */
const NAME_PATTERN = /^[A-Za-z0-9]$|^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/;

/** Why a name was refused. Discriminated so the caller can say what to fix, not just that it is wrong. */
export type NameProblem =
  | "empty"
  | "too-long"
  | "illegal-characters"
  | "traversal"
  | "reserved"
  | "not-lowercase"
  | "git-reserved-suffix";

export interface NameRefusal {
  readonly ok: false;
  readonly name: string;
  readonly problem: NameProblem;
  /**
   * Why the name cannot be used, with no advice in it.
   *
   * Separate from the remedy because one caller needs the reason without the remedy: a run name
   * derived from a workflow reference is refused for reasons that are accurate, and told to "choose
   * another name" for a name nobody chose. Splitting them is what let that be fixed rather than
   * papered over — `defaultRunName` takes the reason and supplies its own remedy.
   *
   * `NameRefusal` rather than `RunNameRefusal`, because a slot refusal is one of these too and a
   * slot has no `--name` and no `defaultRunName` — the same reason `NameProblem` is not
   * `RunNameProblem`. The sentences differ per kind (`runNameSentences`, `slotSentences`); the
   * shape does not.
   */
  readonly reason: string;
  /** Operator-facing, the reason and the remedy together (the gate chain prints this verbatim). */
  readonly message: string;
}

export type RunNameResult = { readonly ok: true; readonly name: RunName } | NameRefusal;

export type SlotNameResult = { readonly ok: true; readonly slot: SlotName } | NameRefusal;

/**
 * The first rule a name breaks, or nothing when it breaks none.
 *
 * One ladder for a run name and a slot, and that is not tidying. Both become a component of a path
 * under the runtime directory and a component of the branch `awcli/<run>/<slot>` (BR-036), so both
 * meet git's ref rules, a filesystem that may ignore case, and a path join. Three of the rungs are
 * invisible from a call site that writes the obvious regex instead: `..` has to be tested before the
 * character class or it is reported as a stray dot, the `.lock` suffix escapes the edge-character
 * rule because `k` is a letter, and the case rule follows from a name being a directory and a ref at
 * once. A second copy would be a weaker copy, and the weakness would be in the code that keeps a
 * workflow's slot from escaping the runtime directory.
 *
 * The order is the message's order as much as the rules': each rung assumes the ones above it have
 * passed, so `reserved` is only ever reported of a name that is otherwise legal.
 *
 * The length limit is read from the constant rather than passed in. It was a parameter, and both
 * call sites passed the same value once `MAX_RUN_NAME_LENGTH` and the slot's own limit were merged
 * — the point of merging them being that a run name and a slot land in one path and one ref and so
 * cannot have separate ceilings. A parameter with one possible value reads as a knob that is not
 * one. `reserved` stays: it genuinely differs per kind, and says so where it is declared.
 */
function firstProblem(
  name: string,
  reserved: readonly string[],
): NameProblem | undefined {
  if (name.length === 0) return "empty";
  if (name.length > MAX_NAME_LENGTH) return "too-long";
  // Before the character test, so `..` is reported as what it is rather than as a stray dot.
  // A name reaching a path join is the one illegal character class with a consequence outside
  // the run's own directory.
  if (name.includes("..")) return "traversal";
  if (!NAME_PATTERN.test(name)) return "illegal-characters";
  // Lowercase only. A name is a directory on a filesystem that may be case-insensitive
  // (APFS, NTFS) and part of a git branch on one that is not, so `Triage` and `triage` would be one
  // lock file and two branches — a pair of runs that contend for state while diverging on disk.
  // Refused rather than lowercased, for the same reason no other name is rewritten.
  if (name !== name.toLowerCase()) return "not-lowercase";
  // git refuses a ref component ending in `.lock`, and it refuses it at branch-creation time —
  // which is after this run has taken its lock and started work. The edge-character rule above
  // does not catch it, because `k` is a letter.
  if (name.endsWith(".lock")) return "git-reserved-suffix";
  if (reserved.includes(name)) return "reserved";
  return undefined;
}

/** Whether a string may be used as a run name, and why not when it may not. */
export function validateRunName(name: string): RunNameResult {
  const problem = firstProblem(name, RESERVED_RUN_NAMES);
  if (problem === undefined) return { ok: true, name: name as RunName };
  return refuse(name, problem, ...runNameSentences(name, problem));
}

/**
 * Why a run name was refused, and what to do about it.
 *
 * The sentences are the kind's own even though the rules are shared, and that split is the point of
 * having one ladder and two tables: every remedy here names `--name`, which is not how a slot
 * arrives and would be advice nobody can take about one. Reason and remedy stay separate fields for
 * the reason `NameRefusal.reason` gives.
 */
function runNameSentences(name: string, problem: NameProblem): [string, string] {
  switch (problem) {
    case "empty":
      return [
        "A run name cannot be empty.",
        "Pass --name a name, or leave --name out and awcli derives one from the workflow reference.",
      ];
    case "too-long":
      return [
        `A run name may be at most ${MAX_NAME_LENGTH} characters; this one is ${name.length}. It becomes a directory name and a branch name.`,
        "Use a shorter one.",
      ];
    case "traversal":
      return [
        `A run name may not contain "..": it becomes a path under ${RUNTIME_DIRECTORY}/${RUN_DIRECTORY}/ and must stay inside it.`,
        "Use a name without it.",
      ];
    case "illegal-characters":
      return [
        `"${printable(name)}" is not usable as a run name: it becomes a directory name and a git branch name, so it may hold only letters, digits, dots, dashes and underscores, and must start and end with a letter or digit.`,
        "Use a name within that.",
      ];
    case "not-lowercase":
      return [
        `"${printable(name)}" must be lowercase: the name is both a directory (on a filesystem that may ignore case) and a git branch (on one that does not), and the two must agree.`,
        `Try "${printable(name.toLowerCase())}".`,
      ];
    case "git-reserved-suffix":
      return [
        `A run name may not end in ".lock": git refuses a branch whose name ends that way, and the name becomes the branch awcli/${printable(name)}/<slot>.`,
        "Use a name that ends in something else.",
      ];
    case "reserved":
      return [
        `"${printable(name)}" is reserved: awcli uses that path for the run's working copies.`,
        "Choose another name.",
      ];
  }
}

/**
 * Whether a string may be used as a slot name, and why not when it may not.
 *
 * Validated rather than sanitised, on the same terms as an explicit run name and for a sharper
 * reason: a slot comes from a workflow, so slugifying one would silently map two slots a workflow
 * meant to keep apart — `review 1` and `review/1` — onto a single working copy and a single branch,
 * which is the collision AWCLI-13 exists to make impossible. It is refused instead, and the refusal
 * names the slot.
 */
export function validateSlotName(slot: string): SlotNameResult {
  const problem = firstProblem(slot, RESERVED_SLOT_NAMES);
  if (problem === undefined) return { ok: true, slot: slot as SlotName };
  return refuse(slot, problem, ...slotSentences(slot, problem));
}

/**
 * No slot name is reserved.
 *
 * A slot is a leaf: `run/worktrees/<run>/<slot>` has no sibling of awcli's below the run's own
 * directory, and the branch it reaches lives in `awcli/<run>/`, a namespace awcli owns outright. An
 * empty list rather than no parameter, so the ladder stays one ladder — see `firstProblem`.
 */
const RESERVED_SLOT_NAMES: readonly string[] = [];

/**
 * The name of the slot a caller with no name to give lands in.
 *
 * Separate from `DEFAULT_SLOT` below, and declared up here, because `slotSentences` interpolates it
 * and `DEFAULT_SLOT` is initialised by `defaultSlot()` — which calls `validateSlotName("main")`,
 * which reaches `slotSentences` if that name ever stops validating. Reading `DEFAULT_SLOT` from
 * there was a read during its own initialiser: verified to produce `ReferenceError: Cannot access
 * 'DEFAULT_SLOT' before initialization` at module load, in place of the diagnostic `defaultSlot`
 * exists to produce. A plain string has no such window.
 */
const DEFAULT_SLOT_NAME = "main";

/** Why a slot was refused, and what to do about it. See `runNameSentences` for why these differ. */
function slotSentences(slot: string, problem: NameProblem): [string, string] {
  switch (problem) {
    case "empty":
      return [
        "A slot name cannot be empty.",
        `Leave the name out to use the default slot "${DEFAULT_SLOT_NAME}", or give the slot a name.`,
      ];
    case "too-long":
      return [
        `A slot name may be at most ${MAX_NAME_LENGTH} characters; this one is ${slot.length}. It becomes the last directory of the working copy's path and the last part of its branch name.`,
        "Use a shorter one.",
      ];
    case "traversal":
      return [
        `A slot name may not contain "..": it becomes a path under ${RUNTIME_DIRECTORY}/${RUN_DIRECTORY}/${WORKTREES_DIRECTORY}/ and must stay inside it.`,
        "Use a name without it.",
      ];
    // These two state the rule rather than the name, unlike their run-name counterparts, and the
    // asymmetry is the wrapper: `acquireWorkspace`'s `invalidSlot` opens `awcli will not use "<slot>"
    // as a slot in the "<run>" run:` and then interpolates this, so a reason that also opens by
    // quoting the name produced `... as a slot in the "nightly" run: "Reviewer" must be lowercase:`
    // — the subject twice and two colons in one sentence. The run-name table has no wrapper and keeps
    // its quoting. The other four slot reasons already state the rule.
    case "illegal-characters":
      return [
        "A slot name becomes a directory name and part of a git branch name, so it may hold only letters, digits, dots, dashes and underscores, and must start and end with a letter or digit.",
        "Name the slot within that.",
      ];
    case "not-lowercase":
      return [
        "A slot name must be lowercase: a slot is both a directory (on a filesystem that may ignore case) and part of a git branch (on one that does not), and the two must agree.",
        `Try "${printable(slot.toLowerCase())}".`,
      ];
    case "git-reserved-suffix":
      return [
        `A slot name may not end in ".lock": git refuses a branch whose name ends that way, and the slot becomes the last part of the branch ${BRANCH_NAMESPACE}/<run>/${printable(slot)}.`,
        "Use a name that ends in something else.",
      ];
    case "reserved":
      // No route reaches this today: RESERVED_SLOT_NAMES is empty, for the reason given there. It is
      // here because the type admits it, and a sentence that cannot be produced is cheaper than a
      // non-null assertion that can be wrong later — the same choice run-lock.ts makes for its
      // unreachable exhaustion message.
      return [
        `"${printable(slot)}" is reserved: awcli uses that name for something else under the run's working copies.`,
        "Name the slot something else.",
      ];
  }
}

/**
 * A refusal, built in one place so the reason and the remedy stay separable.
 *
 * The name is sanitised on the way in. Everything here is echoed back to a terminal, and the branch
 * that refuses a name for its characters is precisely the branch where the name is guaranteed to
 * hold a character that is not a letter, a digit, a dot, a dash or an underscore — an escape
 * sequence and a right-to-left override both qualify. So the refusal quoted attacker-chosen bytes,
 * with the same consequence as in `run-lock.ts` and none of the same protection until the sanitizer
 * became a shared module.
 */
function refuse(
  name: string,
  problem: NameProblem,
  reason: string,
  remedy: string,
): NameRefusal {
  return {
    ok: false,
    name: printable(name),
    problem,
    reason,
    message: `${reason} ${remedy}`,
  };
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
    // Collapse, then strip the ends, so `--nightly--.ts` cannot produce a name the validator would
    // then reject for its edges. The principle is exactly that narrow: what must never happen is a
    // default refused for something slugification itself produced. A default that can be refused at
    // all is fine and has to be — the `validateRunName(slug)` call below refuses a slug that comes
    // out `worktrees`, deliberately.
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/[^a-z0-9]+$/, "");

  if (slug.length === 0) {
    return refuse(
      workflowReference,
      "empty",
      `No run name could be derived from "${printable(workflowReference)}".`,
      "Pass --name to say what this run is called.",
    );
  }
  // Through the validator rather than trusting the slug: reserved names survive slugification
  // untouched, so `worktrees.ts` would otherwise become a legal-looking default that collides.
  const validated = validateRunName(slug);
  if (validated.ok) return validated;
  // The validator's *reason*, and not its remedy. Those remedies are written for a name the operator
  // typed, and they end by telling them to choose another one — advice that makes no sense for a name
  // nobody chose. `./workflows/worktrees.ts` is a legal workflow reference, and being told that
  // "worktrees" is reserved and to pick something else is a puzzle rather than an instruction: there
  // is no `--name` on the command line to change. Forwarding `message` carried the remedy along with
  // the reason and left the puzzle in place behind the new sentence, which is why `reason` exists as
  // its own field.
  return refuse(
    workflowReference,
    validated.problem,
    `awcli derived the run name "${printable(slug)}" from "${printable(workflowReference)}", and it cannot be used. ${validated.reason}`,
    "Pass --name to give this run a name of your own.",
  );
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

/**
 * Where every working copy lives: `<repo>/.awcli/run/worktrees`.
 *
 * A sibling of the runs' own directories rather than a child of one, which is what makes
 * `worktrees` the entry in `RESERVED_RUN_NAMES` — a run of that name would have its state directory
 * *be* this directory, and a working copy would land on top of a state file. The two facts are one
 * decision, so the constant and that list are worth reading together: change either and the other is
 * wrong.
 */
const WORKTREES_DIRECTORY = "worktrees";

/**
 * `<repo>/.awcli/run/worktrees` — the directory every working copy is somewhere beneath.
 *
 * Exported because provisioning checks its answer against this: where a working copy *is* once git
 * has finished with it, resolved through every symlink, has to be inside this directory. That check
 * needs the boundary as a value rather than as a string built a second time.
 */
export function worktreesRoot(repositoryPath: string): string {
  return join(runtimeRoot(repositoryPath), WORKTREES_DIRECTORY);
}

/**
 * `<repo>/.awcli/run/worktrees/<run>/<slot>` — one slot's working copy.
 *
 * The layout is the one the technical design document sets out under `### Persisted Shapes`
 * (`.atelier/design/agentic-workflow-cli-tdd.md`).
 *
 * Derived from the same constants as the lock's path, never from a re-spelling of `.awcli/run`. The
 * runtime directory is the single ignored path (BR-030) and a second literal of it is a second place
 * for the generated ignore line to stop covering everything.
 */
export function worktreePath(
  repositoryPath: string,
  runName: RunName,
  slot: SlotName,
): string {
  return join(runtimeRoot(repositoryPath), WORKTREES_DIRECTORY, runName, slot);
}

/**
 * The directories above a working copy, outermost first — not including the working copy itself.
 *
 * The working copy is excluded because git creates it and awcli refuses to provision over anything
 * already at that path; the ancestors are awcli's own to create, and are what `mkdir` with
 * `recursive` would follow a symlink at. Derived forwards from the layout for the reason
 * `runDirectoryAncestors` gives: a walk back up from the leaf needs a stopping condition, and the
 * obvious one is wrong for the same directory spelled two ways.
 */
export function worktreePathAncestors(
  repositoryPath: string,
  runName: RunName,
): readonly string[] {
  const worktrees = worktreesRoot(repositoryPath);
  return [
    join(repositoryPath, RUNTIME_DIRECTORY),
    runtimeRoot(repositoryPath),
    worktrees,
    join(worktrees, runName),
  ];
}

/**
 * The namespace every working copy's branch sits in.
 *
 * awcli's own, so an operator reading `git branch` can tell which branches are a run's and which are
 * theirs, and so a run's branches can be listed by prefix when AWCLI-22 comes to collect them.
 *
 * Exported because listing by prefix is already needed: git stores a branch as a file under
 * `refs/heads/`, so awcli has to ask what else is in this namespace before it cuts a branch in it —
 * see `workspaceBranchPrefixes`.
 */
export const BRANCH_NAMESPACE = "awcli";

/**
 * The branch names `awcli/<run>/<slot>` sits beneath, and therefore cannot coexist with.
 *
 * A branch and a directory of branches cannot share a name in git: with a branch called `awcli`, or
 * `awcli/<run>`, no branch below it can be created at all. Neither can be awcli's own doing — a slot
 * may not contain a slash, so awcli never puts a ref beneath one of its own branches — so this is
 * about a name an operator already had. Derived here, from the same two parts `workspaceBranch`
 * joins, so a caller checking for the collision cannot spell the namespace a second way.
 */
export function workspaceBranchPrefixes(runName: RunName): readonly string[] {
  return [BRANCH_NAMESPACE, `${BRANCH_NAMESPACE}/${runName}`];
}

/**
 * `awcli/<run>/<slot>` — the branch a slot's working copy is cut on (BR-036).
 *
 * A pure function of the run name and the slot, and nothing else. No timestamp, no uuid, no counter:
 * a resumed run finds what it made by *deriving* the name again, so anything varying per invocation
 * would leave one branch per iteration behind and make reattachment (AWCLI-14) impossible. This is
 * the same property `defaultRunName` has and for the same reason — determinism here is the mechanism,
 * not a convenience.
 */
export function workspaceBranch(runName: RunName, slot: SlotName): string {
  return `${BRANCH_NAMESPACE}/${runName}/${slot}`;
}

/**
 * The slot a caller with no name to give lands in.
 *
 * `DEFAULT_SLOT_NAME`, which is `main`, because that is how it reads on the branch an operator
 * sees: `awcli/triage/main` is the run's own working copy, and the run's name is already the
 * interesting half of that. Auto-allocating a slot per unnamed `sandbox()` call is AWCLI-19's; this
 * is the single slot a run uses when nobody has asked for more than one.
 *
 * Validated at module load rather than cast, so the default cannot drift out of the rules every
 * other slot is held to — a cast here would be the one slot in the system that never met them.
 */
export const DEFAULT_SLOT: SlotName = defaultSlot();

function defaultSlot(): SlotName {
  const result = validateSlotName(DEFAULT_SLOT_NAME);
  if (!result.ok) {
    throw new Error(
      `internal: the default slot is not a legal slot name: ${result.message}`,
    );
  }
  return result.slot;
}
