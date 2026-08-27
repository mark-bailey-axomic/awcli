import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { Acquisition, DisposalStack } from "./disposal.js";
import { printable } from "./printable.js";
import {
  BRANCH_NAMESPACE,
  DEFAULT_SLOT,
  validateSlotName,
  workspaceBranch,
  workspaceBranchPrefixes,
  worktreePath,
  worktreePathAncestors,
  type RunName,
  type SlotName,
} from "./run-identity.js";

/**
 * The working copy a run's agents operate in: a git worktree by default, the operator's own
 * checkout only if they ask for it.
 *
 * An agent editing the operator's live checkout while they are working in it is the failure mode
 * that makes agentic tooling untrustworthy, so the safe choice is the one you get by asking for
 * nothing. Three properties carry that, and each of them is structural rather than documented:
 *
 *   - **The default is a worktree.** Nothing has to be passed to get isolation; the live checkout
 *     takes a value only this module can make (see `LiveCheckoutConsent`), so a workflow cannot
 *     reach it, a cast cannot forge it, and a caller who asks for it without one is refused rather
 *     than quietly given a worktree instead. A silent downgrade in either direction is a run whose
 *     reported isolation is not the isolation it had, which BR-015 exists to prevent.
 *   - **The branch and the path are pure functions of the run name and the slot** (BR-036). A
 *     resumed run finds what it made by deriving the name again, so a timestamp or a counter
 *     anywhere near either would leave a branch per iteration behind and make AWCLI-14's
 *     reattachment impossible. See `workspaceBranch` in run-identity.ts.
 *   - **Provisioning is never destructive.** There is no `git worktree remove` here, no `--force`,
 *     no reset, no checkout over an existing tree and no clean. Anything already at the target path
 *     is a refusal that leaves it exactly as it was — AWCLI-14 turns that refusal into first-class
 *     reuse, and until it lands, refusing is the only answer that cannot destroy work.
 *
 * Worktree isolation is not security isolation, and this file says so in the sentence it hands the
 * operator: it protects the repository, not the machine. The filesystem outside the repository, the
 * network and this machine's credentials all stay reachable (BR-015).
 *
 * **`ctx.git` is deliberately not built here.** A `WorkspaceHandle` *is* the exposure of a working
 * copy's dir, branch, head and dirty state, but `GitApi` also declares `log`, `diff` and `commit`,
 * which nothing in AWCLI-13 builds — and `supports()` answers per member, so a half-built `git`
 * would make it lie in one direction or the other (BR-033). So `DELIVERED_BY` in context.ts is
 * untouched: the loop that builds a context around one of these handles is AWCLI-11's. Read the
 * absence as a decision, not an omission.
 */

/** The resource name the disposal stack reports this under. Operator-facing. */
export const WORKING_COPY_RESOURCE = "working copy";

/**
 * The flag the operator uses to ask for their own checkout, spelled once.
 *
 * Exported so that the CLI wiring (AWCLI-20, AWCLI-06) and every message naming it cannot drift
 * apart. There is no flag handling in `src/cli.ts` yet, on purpose: the resolver below is the same
 * shape as `resolveRunName`, which existed and was tested for several tickets before a command line
 * reached it.
 */
export const LIVE_CHECKOUT_FLAG = "--live-checkout";

/** The workspace axis, spelled as the contract's `Isolation` spells it (ADR-0003). */
export type WorkspaceAxis = "liveTree" | "worktree";

/**
 * The operator's consent to work in their own checkout.
 *
 * A branded, module-private *value*, not a boolean. Three properties are what BR-014 rests on here,
 * and each is worth stating exactly, because the first version of this comment claimed a fourth that
 * is not true:
 *
 *   - **Unforgeable by shape.** The check compares by identity against the frozen sentinel below, so
 *     a frozen `{}`, a spread copy of the real one, `JSON.parse("{}")`, an `Object.create` of it and
 *     a `Proxy` around it are all refused — from JavaScript with no types in play as much as from
 *     TypeScript with a cast. The type is unspellable as well (`liveCheckoutConsentBrand` is a
 *     `unique symbol` with no runtime existence), but that only stops the mistake at the keyboard;
 *     the identity check is what stops it at run time.
 *   - **Mintable in one place.** `resolveWorkspaceChoice` is the only function that produces one, and
 *     it produces one from the operator's flag and nothing else.
 *   - **Out of a workflow's reach.** Not because the sentinel is unexported — it *is* handed out, by
 *     that resolver, and what comes back is an ordinary reusable value that a caller can keep. What
 *     keeps it away from a workflow is that nothing routes workflow input into the resolver:
 *     `SandboxOptions` declares only `name`, and the flag is read from the command line. That is the
 *     property to preserve. A future call site passing workflow-supplied data to
 *     `resolveWorkspaceChoice` would defeat all of this without touching a line in here.
 *
 * BR-014 wants the person whose uncommitted work is at stake to be the one asking. A boolean flag on
 * a request object would have been the obvious design and it is exactly what a workflow could set.
 */
declare const liveCheckoutConsentBrand: unique symbol;
export interface LiveCheckoutConsent {
  readonly [liveCheckoutConsentBrand]: true;
}

/**
 * The one consent value there is.
 *
 * Frozen so that nothing can mutate it into something else, and not exported directly — a caller
 * reaches it only by asking `resolveWorkspaceChoice` for the live checkout, which is the act BR-014
 * wants to be deliberate. Identity against this object is the whole of the run-time check; see
 * `LiveCheckoutConsent` for what that does and does not buy.
 */
const OPERATOR_CONSENT = Object.freeze({}) as LiveCheckoutConsent;

/**
 * Which working copy this run gets.
 *
 * A closed union rather than an axis plus an optional consent, so the type itself says that
 * `liveTree` cannot be named without something in the consent position. The run-time identity check
 * is what closes the gap a cast leaves.
 */
export type WorkspaceChoice =
  | { readonly workspace: "worktree" }
  | { readonly workspace: "liveTree"; readonly consent: LiveCheckoutConsent };

/** What the operator asked for on the command line. Absent and false are the same thing here. */
export interface WorkspaceChoiceRequest {
  readonly liveCheckout?: boolean | undefined;
}

/**
 * The workspace axis for this invocation, and the only thing that mints consent.
 *
 * The operator-facing resolver: it exists at this layer for the same reason `resolveRunName` does —
 * the decision belongs to the command line, and putting it here means the rule is tested before any
 * flag parsing exists to get it wrong.
 */
export function resolveWorkspaceChoice(request: WorkspaceChoiceRequest): WorkspaceChoice {
  return request.liveCheckout === true
    ? { workspace: "liveTree", consent: OPERATOR_CONSENT }
    : { workspace: "worktree" };
}

/**
 * What was obtained, and what it does and does not protect.
 *
 * Deliberately *not* the contract's `Isolation`, which carries an execution `target` as well. No
 * exec target exists on this build (AWCLI-19, AWCLI-25), so reporting `target: "host"` here would be
 * a claim this ticket cannot back — and BR-015 is about isolation being reported honestly, which
 * makes an invented axis worse than a missing one. Whatever composes the two axes into an
 * `Isolation` will do it where both are known.
 */
export interface WorkspaceIsolation {
  readonly workspace: WorkspaceAxis;
  /** One line for the operator and the log, naming what is and is not protected (BR-015). */
  readonly description: string;
}

/**
 * A working copy: where it is, what branch it is on, and what git says about it now.
 *
 * `dir` and `branch` are plain values because awcli chose both before anything ran. `head` and
 * `dirty` ask git, so they are asynchronous and may disagree with a previous answer in the same
 * iteration — an agent committing while the workflow is running is the point, not a hazard.
 */
export interface WorkspaceHandle {
  /** Absolute path to the working copy. */
  readonly dir: string;
  /** The branch it is on: `awcli/<run>/<slot>` for a worktree, the operator's own for a live tree. */
  readonly branch: string;
  /** The slot this working copy belongs to, for logs and branch-name derivation. */
  readonly slot: SlotName;
  readonly isolation: WorkspaceIsolation;
  /** The commit it is on. Recorded against the run (BR-025). */
  readonly head: () => Promise<string>;
  /** Whether it has uncommitted changes — what a resumed run would inherit. */
  readonly dirty: () => Promise<boolean>;
}

/** Why a working copy could not be provisioned. Every one of these is the operator's to fix. */
export type WorkspaceRefusalKind =
  /** The slot broke the naming rules. See `validateSlotName`. */
  | "invalid-slot"
  /** `liveTree` was asked for without the operator's own consent. Never downgraded, never silent. */
  | "live-checkout-not-consented"
  /** git could not be run at all — not installed, or not on the PATH awcli was given. */
  | "git-unavailable"
  /** The path awcli was pointed at is not a git repository. */
  | "not-a-repository"
  /** The repository has no commit, so there is no branch to cut a working copy from. */
  | "no-commit"
  /** The live checkout is on a detached HEAD, so it has no branch to report. */
  | "detached-head"
  /** The branch this slot derives already exists. Reattaching to it is AWCLI-14's. */
  | "branch-exists"
  /** Something is already at the target path. Left exactly as it was; reuse is AWCLI-14's. */
  | "occupied";

export interface WorkspaceRefusal {
  readonly ok: false;
  readonly kind: WorkspaceRefusalKind;
  readonly run: RunName;
  /**
   * The slot this was for, as it was asked for.
   *
   * A plain string rather than a `SlotName`, because the `invalid-slot` refusal is precisely the case
   * where there is no valid slot to report — and sanitised, because that same case is the one where
   * the value is guaranteed to hold something the rules refused. See `printable`.
   */
  readonly slot: string;
  /** Operator-facing: what was refused, why, and what to do about it. */
  readonly message: string;
}

export type WorkspaceOutcome =
  { readonly ok: true; readonly workspace: WorkspaceHandle } | WorkspaceRefusal;

export interface WorkspaceRequest {
  readonly repositoryPath: string;
  /** Branded, so an unvalidated run name cannot reach a path. See `RunName`. */
  readonly runName: RunName;
  /**
   * The slot, as the caller spelled it. Defaults to `DEFAULT_SLOT`.
   *
   * A raw string, unlike the run name, and that asymmetry is deliberate: a run name is validated by
   * the startup gate chain long before this, whereas a slot's only producer is a workflow calling
   * `sandbox({ name })` at run time. So this boundary is where a slot meets the rules, and it comes
   * back as a refusal rather than a throw because a workflow author naming a slot `Review 1` has
   * made a fixable mistake, not caused a fault.
   */
  readonly slot?: string | undefined;
  readonly choice: WorkspaceChoice;
  /** Substituted in tests for the faults a real repository cannot stage. The default runs git. */
  readonly git?: GitRunner;
}

/**
 * What running git produced.
 *
 * `unavailable` is separate from a non-zero exit because the remedy is: a git that cannot be started
 * is a machine that has no git, which no run can work around, while a git that ran and complained is
 * about this repository.
 */
export type GitOutcome =
  | {
      readonly kind: "ran";
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * The seam every git invocation goes through.
 *
 * A port for one reason: the failures that matter here — git missing from the machine, git failing
 * for a reason awcli has no sentence for — cannot be staged against a real repository, and they are
 * the paths where a wrong implementation either refuses when it should throw or throws when it
 * should refuse. Everything else in this unit's suite runs real git against real temp repositories,
 * because a mock cannot tell a worktree from a checkout.
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitOutcome>;

const execFileAsync = promisify(execFile);

/**
 * How long any one git invocation may take.
 *
 * Provisioning is required to cost a bounded amount of time, and `git worktree add` on a large
 * repository is the one call here that does real work. Generous rather than tight: the failure this
 * prevents is a run that hangs for ever on a git waiting for a lock or for credentials, not a slow
 * checkout.
 */
const GIT_TIMEOUT_MS = 120_000;

/** Enough for `git status --porcelain` in a large tree; the answer is only ever read for emptiness. */
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** The real runner: git, in a directory, with its output captured. */
export const systemGitRunner: GitRunner = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
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
    // A number is an exit status: git ran and answered. A string is an errno from the spawn itself.
    if (typeof failure.code === "number") {
      return {
        kind: "ran",
        code: failure.code,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }
    if (failure.code === "ENOENT") {
      return { kind: "unavailable", reason: "git is not installed, or not on the PATH" };
    }
    if (failure.killed === true) {
      throw new Error(
        `git ${printable(args.join(" "))} did not finish within ${GIT_TIMEOUT_MS}ms in ${cwd}. Something is holding a git lock, or waiting for input awcli cannot give it.`,
        { cause: error },
      );
    }
    // EACCES on the binary, EAGAIN from fork on a loaded machine: git could not be started, and that
    // is not this repository's fault. Reported as unavailable so the refusal names the machine.
    if (typeof failure.code === "string") {
      return {
        kind: "unavailable",
        reason: `git could not be run (${printable(failure.code)})`,
      };
    }
    throw error;
  }
};

/**
 * Provisions the working copy for a run and slot, and registers its release.
 *
 * Acquisition goes through the disposal stack rather than handing back something the caller must
 * remember to release: acquiring and registering are the same call, as they are for the run lock,
 * because a call site that has to remember is a call site that will not (ADR-0001).
 *
 * The disposition is `preserve`. The working copy stays on disk and its branch is never deleted —
 * the commits are the deliverable (BR-021, BR-036) — so the release is a genuine no-op on disk, and
 * for a live checkout it touches the operator's tree in no way whatsoever. What the registration
 * buys is the report: the unwind says the working copy was released and preserved, which is how a
 * test can hold BR-021 to the code rather than to a comment. Collecting branches is AWCLI-22's, and
 * it is asked for, never automatic.
 *
 * A condition the operator can fix comes back as a refusal, in the shape the gate chain consumes: a
 * slot that breaks the rules, a repository with no commit, a live checkout asked for without
 * consent, a directory already occupied. A genuine fault — an unwritable disk, a symlink where a
 * directory of the layout belongs, a git that failed for a reason awcli has no sentence for — is
 * thrown, because there is nothing for the operator to choose differently and it must not be
 * mistaken for one of the above.
 */
export async function acquireWorkspace(
  stack: DisposalStack,
  request: WorkspaceRequest,
): Promise<WorkspaceOutcome> {
  const git = request.git ?? systemGitRunner;
  const { runName, choice } = request;
  // Resolved once, here, and everything below uses only the resolved form. Two things need it, and
  // no caller exists yet to have found either: `WorkspaceHandle.dir` is documented absolute, and
  // `worktreePath` joins rather than resolves, so a relative repository path would produce a relative
  // `dir` for `ctx.fs` and `ctx.exec` to resolve again against whatever their cwd happens to be. The
  // same unresolved value is also the target argument of `git worktree add`, where a path beginning
  // with `-` is an option rather than a path. One `resolve` closes both, and it has to be at the
  // boundary — anywhere further in and there are two spellings of the repository in flight.
  const repositoryPath = resolve(request.repositoryPath);

  const refuseWith = (kind: WorkspaceRefusalKind, slot: string, message: string) => ({
    ok: false as const,
    kind,
    run: runName,
    slot,
    message,
  });

  // Before the stack, both of them. Neither needs a resource opened to be decided, and a refusal
  // that has registered an acquisition is a resource nobody asked for appearing in the unwind
  // report.
  const asked = request.slot;
  const validated = asked === undefined ? undefined : validateSlotName(asked);
  if (validated !== undefined && !validated.ok) {
    return refuseWith(
      "invalid-slot",
      validated.name,
      `awcli will not use "${validated.name}" as a slot in the "${runName}" run: ${validated.message} No working copy was provisioned and nothing was changed.`,
    );
  }
  const slot: SlotName = validated === undefined ? DEFAULT_SLOT : validated.slot;

  // The consent check, and the one thing it must never do is fall back. A `liveTree` asked for
  // without the operator's own consent is refused outright: quietly giving a worktree would answer a
  // request with something else, and quietly proceeding would put an agent in their checkout on the
  // strength of a value a workflow could have written.
  if (choice.workspace === "liveTree" && choice.consent !== OPERATOR_CONSENT) {
    return refuseWith(
      "live-checkout-not-consented",
      slot,
      `awcli will not work in your checkout at ${repositoryPath} for the "${runName}" run: working there is the operator's decision and this run has no ${LIVE_CHECKOUT_FLAG} from one. Nothing was provisioned, and awcli has not silently used a worktree instead — run it again with ${LIVE_CHECKOUT_FLAG} to work in your checkout, or without it to have awcli provision a worktree.`,
    );
  }

  // Held outside the acquisition so a refusal survives it: `open` either returns a handle or throws,
  // and there is no third channel through the stack. Same arrangement as `acquireRunLock`.
  let refusal: WorkspaceRefusal | undefined;
  const refuse = (kind: WorkspaceRefusalKind, message: string): never => {
    refusal = refuseWith(kind, slot, message);
    throw new WorkspaceRefusedError(refusal);
  };

  const acquisition: Acquisition<WorkspaceHandle> = {
    name: WORKING_COPY_RESOURCE,
    // Preserved, never destroyed: an interrupted run's work has to still be on disk to inspect, and
    // its branch carries the commits that are the whole deliverable (BR-021, BR-036).
    disposition: "preserve",
    open: async () => {
      const head = await sharedPreflight(git, repositoryPath, refuse);
      return choice.workspace === "liveTree"
        ? await openLiveTree(git, repositoryPath, slot, refuse)
        : await openWorktree(git, repositoryPath, runName, slot, head, refuse);
    },
    // Nothing. A working copy is preserved, so there is nothing to undo — and for a live checkout
    // this is the whole point: releasing it must not touch the operator's tree in any way at all.
    // The registration exists for the report, not for an effect. See the docblock above.
    release: () => {},
  };

  try {
    const workspace = await stack.acquire(acquisition);
    return { ok: true, workspace };
  } catch (error) {
    // The refusal is the interesting exit and the only one that is not a failure. Rethrowing
    // anything else keeps a real fault — an unwritable repository, a symlink in the layout — from
    // being reported as though the operator had asked for the wrong thing.
    if (error instanceof WorkspaceRefusedError) return error.refusal;
    throw error;
  }
}

/** Thrown out of the acquisition so an operator-fixable condition becomes a refusal, not a throw. */
class WorkspaceRefusedError extends Error {
  constructor(readonly refusal: WorkspaceRefusal) {
    super(refusal.message);
    this.name = "WorkspaceRefusedError";
  }
}

/** How a refusal is raised from inside the acquisition. Never returns. */
type Refuse = (kind: WorkspaceRefusalKind, message: string) => never;

/**
 * What both axes need to be true before anything is provisioned, and the commit they share.
 *
 * The order is the order the remedies get narrower in: a machine with no git, a directory that is
 * not a repository, a repository with nothing committed. Asking about the working copy before any of
 * those would produce a git complaint where a sentence belongs.
 *
 * The no-commit check applies to the live checkout as well as to a worktree, though only the worktree
 * needs a commit to cut a branch from: a run records the commit it worked from (BR-025), and a
 * working copy with no commit at all has nothing to record. One rule for both is also one fewer
 * difference between the axes to keep track of.
 */
async function sharedPreflight(
  git: GitRunner,
  repositoryPath: string,
  refuse: Refuse,
): Promise<string> {
  const inside = await git(["rev-parse", "--git-dir"], repositoryPath);
  if (inside.kind === "unavailable") {
    refuse(
      "git-unavailable",
      `awcli cannot provision a working copy: ${inside.reason}. awcli works by making a git worktree, so it needs git on this machine. Install git, or put it on the PATH awcli is run with.`,
    );
  }
  if (inside.code !== 0) {
    refuse(
      "not-a-repository",
      `${repositoryPath} is not a git repository, so awcli has nothing to make a working copy from. Run awcli from a repository, or point it at one.`,
    );
  }

  const head = await run(git, ["rev-parse", "HEAD"], repositoryPath);
  if (head.code !== 0) {
    refuse(
      "no-commit",
      `The repository at ${repositoryPath} has no commit yet, so there is no branch for awcli to cut a working copy from. Make one commit and run again.`,
    );
  }
  return head.stdout.trim();
}

/**
 * The operator's own checkout, which awcli reads and never prepares.
 *
 * Nothing is created, nothing is written, no branch is cut: the whole of this is two questions put to
 * git. That is what the axis means — the operator asked to work where they already are.
 *
 * The slot does not separate anything here, and that is worth stating rather than leaving to be
 * discovered: there is one live checkout however many slots ask for it, so the branch is the
 * operator's own rather than `awcli/<run>/<slot>`, and two slots on this axis would be two handles on
 * one tree. awcli never composes that — `sandbox()` fixes worktree × container (ADR-0003) and the
 * parallel fan-out that allocates slots is AWCLI-19's — so the slot is carried for the log and the
 * run record, where it says which agent this was, and not to pick a directory.
 */
async function openLiveTree(
  git: GitRunner,
  repositoryPath: string,
  slot: SlotName,
  refuse: Refuse,
): Promise<WorkspaceHandle> {
  const current = await run(git, ["branch", "--show-current"], repositoryPath);
  const branch = current.stdout.trim();
  if (current.code !== 0 || branch.length === 0) {
    // `branch --show-current` answers with an empty line on a detached HEAD. Refused rather than
    // reported as an empty branch or as the commit id: a run's branch is what AWCLI-14 reattaches by
    // and what an operator reads, and neither of those has any meaning for a detached head.
    refuse(
      "detached-head",
      `Your checkout at ${repositoryPath} is not on a branch, so awcli cannot say which branch this run worked on. Check out a branch and run again, or leave ${LIVE_CHECKOUT_FLAG} off and let awcli provision a worktree.`,
    );
  }
  return handle(git, repositoryPath, branch, slot, "liveTree");
}

/**
 * A worktree of this run's own, on the branch this run and slot derive.
 *
 * Nothing here removes, forces, resets, checks out over or cleans anything, and the two refusals are
 * what make that a property rather than an intention: an occupied path and an existing branch both
 * stop the provisioning dead and leave what is there untouched. AWCLI-14 is what turns them into
 * reattachment; a `--force` added here would turn them into data loss.
 */
async function openWorktree(
  git: GitRunner,
  repositoryPath: string,
  runName: RunName,
  slot: SlotName,
  head: string,
  refuse: Refuse,
): Promise<WorkspaceHandle> {
  const branch = workspaceBranch(runName, slot);
  const target = worktreePath(repositoryPath, runName, slot);

  // Before the mkdir, and again after it, for the reason `run-lock.ts` gives at length: `mkdir` with
  // `recursive` *follows* an existing symlink at any level, so a repository carrying a committed
  // symlink at `.awcli` or `.awcli/run` would have its working copies created outside the repository
  // altogether — with the operator's own files as a plausible destination.
  await refuseSymlinkedAncestors(repositoryPath, runName);

  const existing = await lstatOrMissing(target);
  if (existing !== undefined) {
    // Anything at all, a symlink included: awcli does not look at what is there and does not act on
    // it. A working copy that already exists is either a run in progress or the last one's, and
    // reusing it deliberately is AWCLI-14's job — which it can only do because nothing here has
    // removed it first.
    refuse(
      "occupied",
      `awcli will not provision a working copy at ${target} for the "${runName}" run: something is there already, and awcli never removes or writes over what it finds. If a run is in progress, wait for it. Otherwise clear it with "git worktree remove ${target}", which is the removal to use rather than deleting the directory: git holds a registration for a working copy as well, and a registration left behind goes on holding this run's branch. That command refuses while there is uncommitted work in there, which is the answer you want.`,
    );
  }

  // One question rather than three. Every ref that can collide with this branch lives at or under
  // `refs/heads/${BRANCH_NAMESPACE}`, and `for-each-ref` with a literal pattern matches that ref
  // itself as well as everything beneath it — so one call answers the exact-branch case and both
  // directory/file cases below.
  const namespaced = await run(
    git,
    ["for-each-ref", "--format=%(refname)", `refs/heads/${BRANCH_NAMESPACE}`],
    repositoryPath,
  );
  const collision = branchCollision(
    branch,
    runName,
    namespaced.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  if (collision !== undefined) {
    // The branch outlives the run that made it (BR-036), so meeting one is ordinary rather than
    // exceptional — it is what a second invocation of the same run and slot finds. Refused, and not
    // reused, moved or deleted: reattaching to an existing branch is AWCLI-14's, and until that
    // exists the honest answer is to stop and say what is in the way.
    refuse("branch-exists", collisionMessage(collision, branch, runName, target));
  }

  try {
    await mkdir(dirname(target), { recursive: true });
  } catch (error) {
    refuseUnwritable(error, dirname(target));
    throw error;
  }
  await refuseSymlinkedAncestors(repositoryPath, runName);

  // No `--force` and no `--detach`: `-b` refuses an existing branch, which is a second line of
  // defence behind the check above rather than a substitute for it, and `HEAD` fixes what the
  // working copy is cut from so it cannot depend on git's own default.
  const added = await run(
    git,
    ["worktree", "add", "-b", branch, target, head],
    repositoryPath,
  );
  if (added.code !== 0) {
    // Every condition awcli has a sentence for was checked above, so whatever this is, it is not
    // something the operator was asked to choose. Thrown rather than refused: a refusal claims awcli
    // knows what is wrong and what to do instead, and here it knows neither.
    throw new Error(
      `awcli could not create a working copy at ${target} for the "${runName}" run: git worktree add exited ${added.code}. ${printable(firstLine(added.stderr), STDERR_LIMIT)}`,
    );
  }

  return handle(git, target, branch, slot, "worktree");
}

/**
 * A ref that stops `awcli/<run>/<slot>` being created, and how.
 *
 * Three shapes rather than one, because the remedy differs and only the first is awcli's own doing.
 * git stores a branch as a file at `refs/heads/<name>`, so a branch and a directory of branches
 * cannot share a name: `awcli` or `awcli/<run>` existing as a branch makes every branch below it
 * uncreatable, and a branch *below* this one makes this one uncreatable. Both were verified against
 * git 2.55 — the second is what `refs/heads/awcli/triage/main/x` does to `awcli/triage/main`.
 *
 * awcli cannot collide with itself this way: a slot may not contain a slash, so it never creates a
 * ref beneath one of its own branches, and the namespace branch would have to have been made by
 * someone else. Which is exactly why this needs a sentence — before it existed, a repository with a
 * branch called `awcli` sent every run into the thrown-fault branch below with git's `cannot lock
 * ref` for an explanation and no next step.
 */
type BranchCollision = {
  /** `same`: this branch. `prefix`: a branch this one would sit under. `below`: one under this one. */
  readonly kind: "same" | "prefix" | "below";
  /** The colliding branch, short form, sanitised — it is a name from the operator's repository. */
  readonly ref: string;
};

/** The first ref that collides with `branch`, or nothing. See `BranchCollision`. */
function branchCollision(
  branch: string,
  runName: RunName,
  existing: readonly string[],
): BranchCollision | undefined {
  const full = `refs/heads/${branch}`;
  if (existing.includes(full)) return { kind: "same", ref: printable(branch) };
  const prefix = workspaceBranchPrefixes(runName).find((candidate) =>
    existing.includes(`refs/heads/${candidate}`),
  );
  if (prefix !== undefined) return { kind: "prefix", ref: printable(prefix) };
  const below = existing.find((ref) => ref.startsWith(`${full}/`));
  if (below !== undefined) {
    return { kind: "below", ref: printable(below.slice("refs/heads/".length)) };
  }
  return undefined;
}

/**
 * What to say about a branch that is in the way, and what to do about it.
 *
 * The `same` remedy names `git worktree remove` as well as `git branch -D`, and that is the finding
 * this function exists for rather than a flourish: release is a no-op and collection is AWCLI-22's,
 * so the operator's only cleanup today is by hand — and deleting the working copy's *directory*
 * leaves git's registration for it, which goes on holding the branch. `git branch -D` then fails with
 * "cannot delete branch ... used by worktree at <a path that is not there any more>", and the run
 * name is unusable until they find `git worktree prune`. Reproduced on git 2.55 before this was
 * written; `git worktree remove` clears the registration even when the directory has already gone.
 */
function collisionMessage(
  collision: BranchCollision,
  branch: string,
  runName: RunName,
  target: string,
): string {
  if (collision.kind === "same") {
    return `awcli will not cut the branch ${branch} for the "${runName}" run: it already exists, and awcli never moves or deletes a branch — the commits on one are the deliverable. If it is finished with, remove the working copy that holds it first with "git worktree remove ${target}" (which works even if that directory has already gone, and "git worktree prune" clears every stale registration at once), then "git branch -D ${branch}". Or run this under a different --name.`;
  }
  const where =
    collision.kind === "prefix"
      ? `the branch ${collision.ref} already exists, and git cannot hold a branch and a directory of branches at the same name`
      : `the branch ${collision.ref} already exists beneath it, and git cannot hold a branch and a directory of branches at the same name`;
  return `awcli cannot cut the branch ${branch} for the "${runName}" run: ${where}. That branch is not one of awcli's — awcli only ever creates branches under ${BRANCH_NAMESPACE}/<run>/<slot> — so rename or delete it, or run this under a different --name.`;
}

/** How much of git's own stderr a message repeats. Enough for the cause, not enough to bury it. */
const STDERR_LIMIT = 200;

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/**
 * The handle both axes hand back.
 *
 * One function so the two axes cannot answer `head()` or `dirty()` differently: both ask git in the
 * working copy's own directory, which for a live tree is the operator's checkout and for a worktree
 * is the worktree. A second copy of these two calls is how the live-tree path ends up reporting the
 * repository's state instead of the working copy's.
 */
function handle(
  git: GitRunner,
  dir: string,
  branch: string,
  slot: SlotName,
  workspace: WorkspaceAxis,
): WorkspaceHandle {
  return {
    dir,
    branch,
    slot,
    isolation: { workspace, description: describe(workspace, dir, branch) },
    head: async () => {
      const answer = await run(git, ["rev-parse", "HEAD"], dir);
      if (answer.code !== 0) {
        throw new Error(
          `awcli could not read the commit the working copy at ${dir} is on: git rev-parse exited ${answer.code}. ${printable(firstLine(answer.stderr), STDERR_LIMIT)}`,
        );
      }
      return answer.stdout.trim();
    },
    dirty: async () => {
      const answer = await run(git, ["status", "--porcelain"], dir);
      if (answer.code !== 0) {
        throw new Error(
          `awcli could not tell whether the working copy at ${dir} has uncommitted changes: git status exited ${answer.code}. ${printable(firstLine(answer.stderr), STDERR_LIMIT)}`,
        );
      }
      return answer.stdout.trim().length > 0;
    },
  };
}

/**
 * The sentence an operator reads about what they got (BR-015).
 *
 * It names what is *not* protected as well as what is, and that is the rule rather than caution:
 * "sandbox" and "worktree" both read as a machine boundary and neither is one. A worktree protects
 * the repository. The filesystem outside it, the network and this machine's credentials stay
 * reachable on both axes, and only a container changes that.
 */
function describe(workspace: WorkspaceAxis, dir: string, branch: string): string {
  return workspace === "liveTree"
    ? `Working directly in your own checkout at ${dir}, on your branch ${branch}, because this run was given ${LIVE_CHECKOUT_FLAG}: uncommitted changes there are an agent's to change, and nothing protects them. Nothing outside the repository is protected either — the filesystem, the network and this machine's credentials are all reachable.`
    : `Working in a worktree at ${dir}, on the branch ${branch}: your own checkout, its branch and its uncommitted changes are untouched. This protects the repository and nothing else — the filesystem outside it, the network and this machine's credentials are all reachable.`;
}

/**
 * git, with the unavailable case turned into a fault.
 *
 * Only `sharedPreflight` asks whether git can be run, because it is the first thing to ask and the
 * answer cannot change during one acquisition. Everything after it is entitled to assume git exists,
 * and a git that has become unavailable *between* two calls in the same acquisition is a machine
 * changing under a run, which is a fault and not a choice the operator can make differently.
 */
async function run(
  git: GitRunner,
  args: readonly string[],
  cwd: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const outcome = await git(args, cwd);
  if (outcome.kind === "unavailable") {
    throw new Error(
      `awcli could not run git in ${cwd} (${printable(outcome.reason)}), having already run it once in this repository. git has gone missing while the run was starting.`,
    );
  }
  return outcome;
}

/**
 * Refuses a symlink anywhere between the repository root and a run's worktree directory.
 *
 * Outside in, stopping at the first component that does not exist: nothing can be below a path that
 * is not there, and `mkdir` will create the rest as real directories. The list comes from
 * `worktreePathAncestors`, derived forwards from the layout — see the note there on why walking back
 * up from the leaf is what gets this wrong.
 *
 * Thrown rather than refused. A committed symlink at `.awcli` is not a choice the operator made
 * about this run, and the consequence — a working copy, and an agent, landing outside the repository
 * — is not something to offer them a different flag for.
 */
async function refuseSymlinkedAncestors(
  repositoryPath: string,
  runName: RunName,
): Promise<void> {
  for (const ancestor of worktreePathAncestors(repositoryPath, runName)) {
    const stats = await lstatOrMissing(ancestor);
    if (stats === undefined) return;
    if (stats.isSymbolicLink()) {
      throw new Error(
        `${ancestor} is a symbolic link, and awcli will not follow one to reach a run's working copies: the working copy, and everything an agent writes in it, would land outside the repository. Remove it and run again.`,
      );
    }
  }
}

async function lstatOrMissing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

/**
 * Turns "cannot write here" into a sentence about the directory, or leaves the error alone.
 *
 * The same failure `run-lock.ts` explains for the run directory, one directory along: an unwritable
 * repository is the one fault on this path an operator can fix without knowing anything about awcli,
 * and an `EACCES` with a stack trace does not tell them so.
 */
function refuseUnwritable(error: unknown, directory: string): void {
  if (isErrno(error, "EACCES") || isErrno(error, "EPERM") || isErrno(error, "EROFS")) {
    throw new Error(
      `awcli cannot create a working copy in ${directory} (${errnoOf(error) ?? "permission denied"}): that directory is not writable. Check its permissions, or run against a repository this user can write to.`,
      { cause: error },
    );
  }
}

function isErrno(error: unknown, code: string): boolean {
  return errnoOf(error) === code;
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
