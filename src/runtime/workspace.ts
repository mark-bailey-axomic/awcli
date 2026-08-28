import type { Stats } from "node:fs";
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Acquisition, DisposalStack } from "./disposal.js";
import { gitComplaint, systemGitRunner, type GitRunner } from "./git-process.js";
import { printable } from "./printable.js";
import {
  BRANCH_NAMESPACE,
  DEFAULT_SLOT,
  validateSlotName,
  workspaceBranch,
  workspaceBranchPrefixes,
  worktreePath,
  worktreePathAncestors,
  worktreesRoot,
  type RunName,
  type SlotName,
} from "./run-identity.js";

/**
 * The working copy a run's agents operate in: a git worktree by default, the operator's own
 * checkout only if they ask for it.
 *
 * An agent editing the operator's live checkout while they are working in it is the failure mode
 * that makes agentic tooling untrustworthy, so the safe choice is the one you get by asking for
 * nothing. Three properties carry that, and they are not equally strong — which is worth saying
 * here rather than leaving the summary to overstate what the code below delivers:
 *
 *   - **The default is a worktree.** Nothing has to be passed to get isolation. The live checkout
 *     takes a value only this module mints (see `LiveCheckoutConsent`), and a caller who asks for it
 *     without one is refused outright rather than quietly given a worktree instead — a silent
 *     downgrade in either direction is a run whose reported isolation is not the isolation it had,
 *     which BR-015 exists to prevent. What is structural is that the value cannot be forged: the
 *     check is by identity, so a cast does not produce one. What is *not* structural is that a
 *     workflow cannot obtain one — nothing routes workflow input into the resolver today, and
 *     AWCLI-20's flag parsing is the call site that could change that. `LiveCheckoutConsent` sets
 *     out the three properties one at a time; read that before relying on this paragraph.
 *   - **The branch and the path are pure functions of the run name and the slot** (BR-036). A
 *     resumed run finds what it made by deriving the name again, so a timestamp or a counter
 *     anywhere near either would leave a branch per iteration behind and make AWCLI-14's
 *     reattachment impossible. See `workspaceBranch` in run-identity.ts.
 *   - **Provisioning is never destructive.** awcli never runs `git worktree remove`, never passes
 *     `--force`, and never resets, checks out over an existing tree or cleans. Anything already at
 *     the target path is a refusal that leaves it exactly as it was — AWCLI-14 turns that refusal
 *     into first-class reuse, and until it lands, refusing is the only answer that cannot destroy
 *     work. The one thing this file removes is the empty directory it created itself moments
 *     earlier, when git then failed, and `rmdir` is what holds it to "empty". Note that the
 *     refusals do *advise* `git worktree remove`: what awcli will not do on its own, an operator
 *     may well want to do, and the message's job is to name the command that works.
 *
 * Provisioning itself runs no code out of the repository. `git worktree add` performs a checkout,
 * and a checkout runs `post-checkout` from the *shared* git dir — so the one moment awcli acts with
 * the operator's identity, before any execution boundary exists, would be handing execution to a
 * file any agent in any slot can have written. Hooks are off for it (`NO_HOOKS`), and `describe`
 * says so, because "the worktree protects your checkout" is not a claim to make while making the
 * worktree ran the repository's code.
 *
 * Worktree isolation is not security isolation, and this file says so in the sentence it hands the
 * operator: it protects the repository, not the machine (BR-015). What it does *not* say is what an
 * agent can reach beyond the repository, because that is the execution axis's answer and this module
 * carries no execution target — see `WorkspaceIsolation` and `describe`.
 *
 * **`ctx.git` is deliberately not built here.** A `WorkspaceHandle` *is* the exposure of a working
 * copy's dir, branch, head and dirty state, but `GitApi` also declares `log`, `diff` and `commit`,
 * which nothing in AWCLI-13 builds — and `supports()` answers per member, so a half-built `git`
 * would make it lie in one direction or the other (BR-033). AWCLI-14 owns the member end to end:
 * `DELIVERED_BY` in context.ts points there, and the amendment that widened that ticket to cover
 * `log`, `diff` and `commit` is the `ctx.git` row in the rules file's `## Amendments` section. Read
 * the absence here as a decision, not an omission.
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
 * A branded, module-private *value*, not a boolean. Three properties are what BR-014 rests on here.
 * They are stated one at a time and bounded rather than summarised, because the summary a reader
 * would write from them — that a workflow cannot obtain one — is a fourth property, and it holds for
 * a different reason than the three do:
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
 *     `SandboxOptions` declares only `name`, the flag is read from the command line, and nothing in
 *     `src/` performs a dynamic `import` at all, so there is no workflow code in this process to
 *     call the resolver in the first place. That is the property to preserve, and it is the weakest
 *     of the three: it is a fact about the call sites that exist today, not about this module.
 *
 *     What preserves it is a rule for the ticket that changes it. AWCLI-20 is where a workflow first
 *     gets loaded in-process, and the requirement on that ticket is that `resolveWorkspaceChoice` is
 *     called from the CLI layer, from the parsed command line, and the `WorkspaceChoice` handed down
 *     — never re-derived anywhere a workflow can reach. Binding the consent to the run name instead
 *     was considered and is not the answer: a workflow knows its own run name, so it would satisfy
 *     the check as readily as the CLI does, and the ceremony would read as a guarantee where the
 *     call-site rule is the whole of it.
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
  // Resolved once, here, and everything below uses only the resolved form.
  //
  // What this buys has *narrowed*, and saying so is the point: `WorkspaceHandle.dir` and the
  // `git worktree add` target are now derived from `rev-parse --show-toplevel`, which answers
  // absolutely whatever git was asked from, so neither depends on this any more. What still does is
  // every sentence raised before that answer exists — the live-checkout refusal, the
  // not-a-repository refusal, the missing-directory one — and those are the messages an operator
  // has to act on. A relative path in one of them is only actionable from the directory awcli
  // happened to be run in, which is not where the operator will be reading it. It stays at the
  // boundary for the original reason: anywhere further in and there are two spellings of the
  // repository in flight.
  const repositoryPath = resolve(request.repositoryPath);

  const refuseWith = (kind: WorkspaceRefusalKind, slot: string, message: string) => ({
    ok: false as const,
    kind,
    run: runName,
    slot,
    message,
  });

  // The slot is decided out here because two things need it before anything is opened: the refusal
  // shape carries it, and so does the message for a slot that is not usable. Deciding is all that
  // happens here — the *answer* is given inside `open` with every other one, see below.
  const asked = request.slot;
  const validated = asked === undefined ? undefined : validateSlotName(asked);
  const invalidSlot = (refusal: Extract<typeof validated, { ok: false }>) =>
    refuseWith(
      "invalid-slot",
      refusal.name,
      `awcli will not use "${refusal.name}" as a slot in the "${runName}" run: ${refusal.message} No working copy was provisioned and nothing was changed.`,
    );
  const slot: SlotName =
    validated === undefined || !validated.ok ? DEFAULT_SLOT : validated.slot;

  // The refusal travels on the error and nowhere else. `open` either returns a handle or throws,
  // there is no third channel through the stack, and `DisposalStack.acquire` rethrows what `open`
  // threw unchanged — so the catch below reads the refusal off the error it caught. A copy held in a
  // binding out here would be read by a future edit *instead* of the error, and a path that reaches
  // it without the throw having happened would report success on a refused run.
  const refuse = (kind: WorkspaceRefusalKind, message: string): never => {
    throw new WorkspaceRefusedError(refuseWith(kind, slot, message));
  };

  const acquisition: Acquisition<WorkspaceHandle> = {
    name: WORKING_COPY_RESOURCE,
    // Preserved, never destroyed: an interrupted run's work has to still be on disk to inspect, and
    // its branch carries the commits that are the whole deliverable (BR-021, BR-036).
    disposition: "preserve",
    open: async () => {
      // Inside `open`, with the six that need git, and that is the point rather than an accident of
      // placement. `DisposalStack.acquire` refuses outright once an unwind has begun, so a check
      // decided *before* it went on answering while the run was shutting down: a workflow's
      // in-flight `sandbox({ name: "Review 1" })` was told its slot name was illegal — implying a
      // workflow bug — while its sibling `sandbox({ name: "reviewer" })` was told the run was
      // closing. One question, two answers, decided by which refusal it would have been. Nothing is
      // lost by moving them: a failed `open` is spliced out of the stack's entries, so neither shows
      // up in the unwind report either way (disposal.ts).
      if (validated !== undefined && !validated.ok) {
        throw new WorkspaceRefusedError(invalidSlot(validated));
      }
      // The consent check, and the one thing it must never do is fall back. A `liveTree` asked for
      // without the operator's own consent is refused outright: quietly giving a worktree would
      // answer a request with something else, and quietly proceeding would put an agent in their
      // checkout on the strength of a value a workflow could have written.
      if (choice.workspace === "liveTree" && choice.consent !== OPERATOR_CONSENT) {
        refuse(
          "live-checkout-not-consented",
          `awcli will not work in your checkout at ${repositoryPath} for the "${runName}" run: working there is the operator's decision and this run has no ${LIVE_CHECKOUT_FLAG} from one. Nothing was provisioned, and awcli has not silently used a worktree instead — run it again with ${LIVE_CHECKOUT_FLAG} to work in your checkout, or without it to have awcli provision a worktree.`,
        );
      }
      const { root, head } = await sharedPreflight(git, repositoryPath, refuse);
      return choice.workspace === "liveTree"
        ? await openLiveTree(git, root, slot, refuse)
        : await openWorktree(git, root, runName, slot, head, refuse);
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

/**
 * How much of a path a message shows.
 *
 * Longer than `printable`'s own default, which is sized for a hostname: a repository path an
 * operator has to recognise is legitimately long, and truncating it to 64 characters would hide the
 * end, which is the part that is usually wrong.
 */
const PATH_LIMIT = 256;

/**
 * The arguments that keep a git invocation from running the repository's hooks.
 *
 * A path under `/dev/null`, which is a character device on every platform awcli runs on: nothing can
 * exist beneath it and nothing can create anything there, so this cannot become a directory an agent
 * plants a hook in — which a path inside the repository, or a temporary directory, could. git looks
 * for the hook, does not find it, and proceeds; verified against git 2.55, where the same add runs
 * the hook without this and does not with it.
 */
const NO_HOOKS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null/awcli-runs-no-hooks",
];

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
): Promise<{ readonly root: string; readonly head: string }> {
  const inside = await git(["rev-parse", "--git-dir"], repositoryPath);
  if (inside.kind === "unavailable") {
    refuse(
      "git-unavailable",
      // The reason is stated without naming a worktree, because this refusal is raised for both
      // axes: an operator who passed --live-checkout would otherwise be told awcli works by making a
      // worktree, which is exactly what that flag stopped it doing, and could reasonably conclude
      // the flag had been ignored.
      `awcli cannot provision a working copy: ${inside.reason}. awcli reads the repository through git whichever working copy a run is given, so it needs git on this machine. Install git, or put it on the PATH awcli is run with.`,
    );
  }
  // A path that is not there is a mistyped `--repo`, and it used to arrive here as
  // `git-unavailable` — the errno for a missing `cwd` and for a missing binary is the same one, so
  // the operator was told to install git on a machine that had it, and this refusal was unreachable
  // by that route. `git-process.ts` tells the two apart; this says what to do about the one that is
  // about the repository.
  if (inside.kind === "no-such-directory") {
    refuse(
      "not-a-repository",
      `There is no directory at ${printable(inside.path, PATH_LIMIT)}, so awcli has nothing to make a working copy from. Check the path — awcli did not get as far as asking git about it.`,
    );
  }
  if (inside.code !== 0) {
    // With git's own complaint attached, which this used to drop. A non-zero exit here is not
    // evidence of *why*: a repository owned by another uid exits 128 with `fatal: detected dubious
    // ownership` and the exact remedy, and replacing that with "is not a git repository" is a
    // confident sentence about a cause awcli never established. The refusal keeps its own remedy —
    // it is right for the common case — and git says the rest.
    refuse(
      "not-a-repository",
      `${repositoryPath} is not a git repository, so awcli has nothing to make a working copy from. Run awcli from a repository, or point it at one. git said: ${gitComplaint(inside.stderr)}`,
    );
  }

  // Where the repository *starts*, which is not necessarily where awcli was pointed. `rev-parse
  // --git-dir` exits 0 from every subdirectory, so `--repo /repo/packages/api` passed every check
  // above and then built the whole layout under the subdirectory: a second `.awcli/run` inside the
  // repository, holding a working copy the one generated ignore line (BR-030) does not cover, while
  // the branch was cut in the repository above. The layout follows from this answer; the path the
  // operator gave stays what git is asked *from*.
  const top = await run(git, ["rev-parse", "--show-toplevel"], repositoryPath);
  const root = top.stdout.trim();
  if (top.code !== 0 || root.length === 0) {
    // A bare repository is the reachable case: it is a repository, so the refusal above does not
    // fire, and it has no working tree for `.awcli/run` to live in. Thrown rather than refused
    // because there is no different flag to offer — everything a run owns is kept in the repository
    // it works on, and a repository with no working tree has nowhere to keep it.
    throw new Error(
      `awcli could not find the root of the repository at ${repositoryPath}: git rev-parse --show-toplevel exited ${top.code}. ${gitComplaint(top.stderr)} awcli keeps everything a run owns under <repository>/.awcli/run, so it needs a repository with a working tree.`,
    );
  }

  // `--verify --quiet`, because the two answers this used to fold together have opposite remedies.
  // A repository with nothing committed exits 1; a repository awcli cannot read — dubious
  // ownership, a HEAD pointing at a missing ref — exits 128 with a fatal of its own. Mapping every
  // non-zero exit to "no commit yet" told an operator with a full history to make their first one.
  const head = await run(
    git,
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    repositoryPath,
  );
  if (head.code === 1) {
    refuse(
      "no-commit",
      `The repository at ${root} has no commit yet, so there is no branch for awcli to cut a working copy from. Make one commit and run again.`,
    );
  }
  if (head.code !== 0) {
    throw new Error(
      `awcli could not read the commit the repository at ${root} is on: git rev-parse HEAD exited ${head.code}. ${gitComplaint(head.stderr)}`,
    );
  }
  return { root, head: head.stdout.trim() };
}

/**
 * The operator's own checkout, which awcli reads and never prepares.
 *
 * Nothing is created, nothing is written, no branch is cut: this asks git which branch the checkout
 * is on and does nothing else. That is what the axis means — the operator asked to work where they
 * already are. It is not the whole of what the live-checkout path costs, and a count here would
 * invite a reader to think it were: `sharedPreflight` runs first on this axis too, so a live
 * checkout is also refused for a machine with no git, a directory that is not a repository, and a
 * repository with no commit.
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
  if (current.code !== 0) {
    // Kept apart from the refusal below, which the two used to share. `--show-current` answers an
    // empty line on a detached HEAD and exits zero doing it, so a non-zero exit is something else —
    // and the likeliest something else is a git older than 2.22, which has no `--show-current` at
    // all. Folded together, an operator on git 2.21 sitting on `main` was refused with "check out a
    // branch and run again": advice that cannot work, because they are on one. The minimum git
    // version is stated in the README beside the Node one.
    throw new Error(
      `awcli could not read which branch your checkout at ${repositoryPath} is on: git branch --show-current exited ${current.code}. ${gitComplaint(current.stderr)} awcli needs git 2.22 or later, which is where --show-current arrived.`,
    );
  }
  // Sanitised, because this one is not awcli's name. A run's own branches are refused unless they
  // are already lowercase letters, digits, dots, dashes and underscores — but the live checkout's
  // branch is whatever the repository has, and git's ref rules ban only the C0 controls and DEL.
  // The bidirectional format characters are legal in a ref and are the class `printable` exists for:
  // a branch called `main‮...` reverses the rendering of everything after it in the BR-015
  // sentence, so the operator reads a line awcli did not emit. The refusal path already sanitises
  // refs read out of the same repository (`branchCollision`'s `short`); this is the success path.
  const branch = printable(current.stdout.trim(), PATH_LIMIT);
  if (branch.length === 0) {
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

  // Before anything, for the reason `run-lock.ts` gives at length: a symlink at `.awcli` or
  // `.awcli/run` would have this run's working copies created outside the repository altogether,
  // with the operator's own files as a plausible destination. This is the early, well-worded
  // refusal — it reads the layout as it stands and says which component is the problem. What
  // actually keeps awcli from writing through a link is `makeLayout` below, which checks each level
  // as it creates it; see there for why one check up front cannot be the guarantee.
  await assertNoSymlinkedAncestors(repositoryPath, runName);

  const existing = await lstatOrMissing(target);
  if (existing !== undefined) {
    // Anything at all, a symlink included: awcli does not look at what is there and does not act on
    // it. A working copy that already exists is either a run in progress or the last one's, and
    // reusing it deliberately is AWCLI-14's job — which it can only do because nothing here has
    // removed it first.
    refuse(
      "occupied",
      await occupiedMessage(git, repositoryPath, target, runName, branch),
    );
  }

  const namespaced = await namespaceRefs(git, repositoryPath);
  if (!namespaced.ok) {
    // Thrown rather than read as "nothing in the way". Every other git call in this module inspects
    // its exit status, and this one used its stdout unconditionally — but a non-zero exit yields
    // empty stdout, so an unreadable `packed-refs` was indistinguishable from a repository with no
    // awcli branches at all, and the run walked on into `git worktree add` to fail there with no
    // remedy. A question awcli could not get an answer to is a fault: there is nothing for the
    // operator to choose differently, and answering it wrongly is what costs them the refusal.
    throw new Error(
      `awcli could not list the branches in ${repositoryPath}, so it cannot tell whether ${branch} is free: git for-each-ref exited ${namespaced.code}. ${gitComplaint(namespaced.stderr)}`,
    );
  }
  const collision = branchCollision(branch, runName, namespaced.refs);
  if (collision !== undefined) {
    // The branch outlives the run that made it (BR-036), so meeting one is ordinary rather than
    // exceptional — it is what a second invocation of the same run and slot finds. Refused, and not
    // reused, moved or deleted: reattaching to an existing branch is AWCLI-14's, and until that
    // exists the honest answer is to stop and say what is in the way.
    refuse(
      "branch-exists",
      await collisionMessage(git, repositoryPath, collision, branch, runName, target),
    );
  }

  await makeLayout(repositoryPath, runName);

  // awcli creates the target directory itself, and this is the close of a race rather than a
  // convenience. The `lstat` at the top of this function is the early, well-worded refusal; it cannot
  // be the guarantee, because between it and the `git worktree add` below sit a subprocess and the
  // creation of four directories. A symlink planted at the target inside that window is followed by
  // git — reproduced on git 2.55, which checked the tree out at the link's destination *outside the
  // repository* while the handle and the sentence shown to the operator both said it was inside,
  // which is the exact failure `assertNoSymlinkedAncestors` exists to prevent, one level down.
  //
  // A non-recursive `mkdir` is what closes it: it never follows a final symlink, so it answers EEXIST
  // for one rather than creating anything through it, and `git worktree add` accepts a directory that
  // already exists as long as it is empty. So the path awcli checked and the path git uses are the
  // same path, established by the same call that would have failed if they were not.
  try {
    await mkdir(target);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      refuse(
        "occupied",
        await occupiedMessage(git, repositoryPath, target, runName, branch),
      );
    }
    faultOnUnwritable(error, dirname(target));
    throw error;
  }

  // No `--force` and no `--detach`: `-b` refuses an existing branch, which is a second line of
  // defence behind the check above rather than a substitute for it, and `HEAD` fixes what the
  // working copy is cut from so it cannot depend on git's own default.
  //
  // With hooks off, which is not a detail: `git worktree add` performs a checkout, and a checkout
  // runs `post-checkout` — resolved through the *common* git dir and through `core.hooksPath` in the
  // shared config, neither of which is per-worktree. So the hook a run executes here is one any
  // agent in any slot of any run can have written, and provisioning is the moment before AWCLI-25's
  // execution boundary exists, with the operator's own identity. awcli's isolation prose is bounded
  // at what an agent reaches *from inside its working copy*; handing execution to a file in the
  // repository as part of making that working copy is outside what that sentence covers, so it does
  // not happen. See `describe`.
  const added = await run(
    git,
    [...NO_HOOKS, "worktree", "add", "-b", branch, target, head],
    repositoryPath,
  );
  if (added.code !== 0) {
    // The empty directory awcli made a moment ago goes back, and only ever while it is still empty:
    // `rmdir` is what makes that a property rather than an intention, since it refuses a directory
    // with anything in it — including a `git worktree add` that got far enough to write something
    // before failing, which is git's to account for and not awcli's to delete. Without this, a
    // transient git failure leaves a directory behind that the *next* invocation reports as occupied,
    // which is a run blocked by awcli's own leftover: the self-inflicted window this file keeps
    // having to close. Best effort, because the error below is the one worth reporting.
    await rmdir(target).catch(ignoreCleanupFailure);
    // The conditions awcli has sentences for were checked above — but a check is not a guarantee,
    // and cannot be: a `mkdir` and a subprocess sit between the last of them and this call, and `-b`
    // is the second line of defence that catches whatever landed in that window. So the collision
    // question is put again, to the repository as it is now, before the fault is raised. A branch
    // that appeared meanwhile has a refusal already written for it, and reporting it as
    // `git worktree add exited 128` hands the operator git's exit status where a remedy exists.
    //
    // The `occupied` half of the same window needs no second look: `mkdir(target)` above is what
    // claims the path, and it fails with EEXIST rather than reaching here if anything — another
    // acquisition of this run and slot included — got there first.
    const late = await lateCollision(git, repositoryPath, runName, branch);
    if (late !== undefined) {
      refuse(
        "branch-exists",
        await collisionMessage(git, repositoryPath, late, branch, runName, target),
      );
    }
    // Nothing awcli has a sentence for, then. Thrown rather than refused: a refusal claims awcli
    // knows what is wrong and what to do instead, and here it knows neither.
    throw new Error(
      `awcli could not create a working copy at ${target} for the "${runName}" run: git worktree add exited ${added.code}. ${gitComplaint(added.stderr)}`,
    );
  }

  // Where the working copy actually is, asked once git has finished with it.
  //
  // Everything above is checked-then-used and no arrangement of `lstat` and `mkdir` closes that
  // completely: the kernel resolves the path again — for `mkdir`, and then for git — after awcli
  // last looked, and node offers no `openat`/`O_NOFOLLOW` to make the check and the use one act. So
  // the last word is the one answer that cannot be raced ahead of: where the target resolves to
  // now. A working copy outside the runtime directory is a fault whoever put it there, because
  // `WorkspaceHandle.dir` and the BR-015 sentence would both name a path inside the repository
  // while an agent worked outside it — which is the whole of what this module promises.
  await assertInsideRuntimeDirectory(repositoryPath, target);

  return handle(git, target, branch, slot, "worktree");
}

/**
 * Refuses a target that is not, in fact, inside the runtime directory.
 *
 * `realpath` on both sides, and the comparison is against the resolved boundary rather than against
 * the spelling: `/repo/.awcli/run/worktrees` reached through a symlinked `/repo` is still inside the
 * runtime directory, and a target that resolves next door to it is not. A `realpath` that fails is
 * refused too — this is the check that says where the working copy is, and "awcli could not tell"
 * is not an answer to hand back as a handle.
 */
async function assertInsideRuntimeDirectory(
  repositoryPath: string,
  target: string,
): Promise<void> {
  const boundary = await realpath(worktreesRoot(repositoryPath)).catch(() => undefined);
  const placed = await realpath(target).catch(() => undefined);
  if (
    boundary === undefined ||
    placed === undefined ||
    !placed.startsWith(`${boundary}${sep}`)
  ) {
    throw new Error(
      `awcli made a working copy at ${target}, and it is not inside ${worktreesRoot(repositoryPath)}: it is at ${placed ?? "a path awcli could not resolve"}. That is outside the runtime directory, so an agent would be working outside the repository while everything awcli reports says otherwise. Nothing was removed — look at what is at that path before running again.`,
    );
  }
}

/**
 * Whether git has a working copy registered at a path.
 *
 * The question the `occupied` refusal turns on, because the two answers have different remedies and
 * one of them is a command git rejects: `git worktree remove` on an ordinary directory exits 128
 * with `fatal: ... is not a working tree` (confirmed on git 2.55). The first version of that message
 * advised it unconditionally, on a branch whose own comment says it fires for *anything at all*, and
 * the test only string-matched the sentence — so the suite was green over advice that does not run.
 *
 * `unknown` is a third answer rather than a default to one of the others, and it is why this asks git
 * through the raw runner instead of through `run`: this builds a *refusal message*, so it must not
 * throw, and a git that cannot answer must not be turned into a confident sentence in either
 * direction.
 *
 * Paths are compared with the parent resolved and the last component left alone. `git worktree list`
 * prints canonical paths — on macOS `/private/var/...` where awcli holds `/var/...` — so a string
 * comparison answers `unregistered` for every worktree in a temp directory; and resolving the whole
 * path instead would follow a symlink at the target, which is one of the things that can be there.
 */
type WorktreeRegistration = "registered" | "unregistered" | "unknown";

async function worktreeRegistration(
  git: GitRunner,
  repositoryPath: string,
  target: string,
): Promise<WorktreeRegistration> {
  // Guarded, because "does not throw" was an intention rather than a property: the raw runner is
  // not total. It throws for an answer larger than awcli reads and for a git it had to kill on the
  // timeout — and this is called while building a refusal, so that rejection escaped
  // `acquireWorkspace` past the `WorkspaceRefusedError` catch and an operator with an occupied
  // target got `git worktree list --porcelain did not finish within 120000ms` instead of the
  // refusal and its remedies. `unknown` is the answer that already exists for "git could not say",
  // and a git that could not be run at all is a git that could not say.
  const listed = await git(["worktree", "list", "--porcelain"], repositoryPath).catch(
    () => undefined,
  );
  if (listed === undefined || listed.kind !== "ran" || listed.code !== 0)
    return "unknown";
  const wanted = await canonicalPath(target);
  for (const line of listed.stdout.split("\n")) {
    const prefix = "worktree ";
    if (!line.startsWith(prefix)) continue;
    if ((await canonicalPath(line.slice(prefix.length).trim())) === wanted) {
      return "registered";
    }
  }
  return "unregistered";
}

/**
 * A path with its parent resolved and its own last component untouched. See the note above.
 *
 * The `catch` is a fallback with a cost, which is worth naming here rather than leaving to be found:
 * `resolve` is not `realpath`, so if the parent could not be resolved this answers a spelling git
 * may not use, the comparison in `worktreeRegistration` misses, and a *registered* working copy is
 * reported `unregistered` — with the remedy that leaves the registration behind holding the branch.
 * It is a fallback rather than an `unknown` because the case it covers is the parent having gone
 * between the `lstat` that found something at the target and this call: nothing is registered at a
 * path whose parent does not exist, so `unregistered` is the true answer for it. What must not
 * happen is this branch quietly widening to cover cases where that reasoning does not hold.
 */
async function canonicalPath(path: string): Promise<string> {
  try {
    return join(await realpath(dirname(path)), basename(path));
  } catch {
    return resolve(path);
  }
}

/**
 * What to say about a target that is not free, and the remedy that fits what is actually there.
 *
 * Three remedies, because there are three truths. A registered working copy is cleared with
 * `git worktree remove`, which also clears the registration that would otherwise go on holding this
 * run's branch — and which refuses while there is uncommitted work in it, which is the answer an
 * operator wants. Anything else is an ordinary directory as far as git is concerned and `git worktree
 * remove` refuses it, so the remedy is to move it or delete it. And when git could not be asked, the
 * sentence names both rather than guessing at one.
 */
async function occupiedMessage(
  git: GitRunner,
  repositoryPath: string,
  target: string,
  runName: RunName,
  branch: string,
): Promise<string> {
  const registration = await worktreeRegistration(git, repositoryPath, target);
  const remedy =
    registration === "registered"
      ? `Otherwise that is a working copy git still has registered, so clear it with "git worktree remove ${target}" rather than by deleting the directory — a registration left behind goes on holding this run's branch — and then "git branch -D ${branch}" if the branch is finished with too. The removal refuses while there is uncommitted work in there, which is the answer you want.`
      : registration === "unregistered"
        ? `Otherwise git has no working copy registered there, so it is an ordinary directory as far as git is concerned and "git worktree remove" would refuse it: move it or delete it yourself, then run again.`
        : `Otherwise clear it before running again — "git worktree remove ${target}" if git still has a working copy registered there, and an ordinary move or delete if it does not. awcli could not ask git which of the two this is.`;
  return `awcli will not provision a working copy at ${target} for the "${runName}" run: something is there already, and awcli never removes or writes over what it finds. If a run is in progress, wait for it. ${remedy}`;
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

/**
 * Every branch in the repository, or why git could not say.
 *
 * All of them rather than the namespace, which is the correction: this asked
 * `for-each-ref refs/heads/${BRANCH_NAMESPACE}`, and git matches that pattern *case-sensitively*
 * while `branchCollision` compares with case folded. A branch called `AWCLI` was therefore never in
 * the list the fold folds, so the fold had nothing to fold against and the case the fold exists for
 * — an operator's branch colliding with awcli's namespace on a case-insensitive filesystem — walked
 * on into `git worktree add` and came back as `exited 128` with no remedy. Verified on git 2.55:
 * with `refs/heads/AWCLI` present, the namespaced query prints nothing and the add fails.
 *
 * So the pattern stops being the filter and `branchCollision` becomes the whole of it, in the one
 * place that already folds. The cost is a longer list from a repository with many branches, read
 * once per acquisition and never printed.
 *
 * The failure is returned rather than thrown because the two call sites want different things from
 * it: before the add it is a fault, and after a failed add it is a second opinion awcli can do
 * without.
 */
async function namespaceRefs(
  git: GitRunner,
  repositoryPath: string,
): Promise<
  | { readonly ok: true; readonly refs: readonly string[] }
  | { readonly ok: false; readonly code: number; readonly stderr: string }
> {
  const listed = await run(
    git,
    ["for-each-ref", "--format=%(refname)", "refs/heads"],
    repositoryPath,
  );
  if (listed.code !== 0) {
    return { ok: false, code: listed.code, stderr: listed.stderr };
  }
  return {
    ok: true,
    refs: listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}

/**
 * The same question again, after `git worktree add` has already failed.
 *
 * Nothing when git cannot answer: the caller is on its way to raising a fault that names git's own
 * complaint, and replacing that with a second complaint about a follow-up query would bury the one
 * the operator needs. Only a collision it can actually see turns the fault into a refusal.
 */
async function lateCollision(
  git: GitRunner,
  repositoryPath: string,
  runName: RunName,
  branch: string,
): Promise<BranchCollision | undefined> {
  const namespaced = await namespaceRefs(git, repositoryPath).catch(() => undefined);
  if (namespaced === undefined || !namespaced.ok) return undefined;
  return branchCollision(branch, runName, namespaced.refs);
}

/**
 * The first ref that collides with `branch`, or nothing. See `BranchCollision`.
 *
 * Compared with case folded, which is wider than git's own ref rules and deliberately so. git
 * resolves a loose ref through the filesystem, and the filesystem ignores case on the APFS and NTFS
 * defaults — so `awcli/Triage` and `awcli/triage` are one ref there and two on ext4. An exact
 * comparison misses the first case entirely: git then answers `fatal: cannot lock ref` and the run
 * exits through the thrown fault this type exists to stop, or, with the ref packed rather than loose,
 * the add succeeds and leaves two branches a case-insensitive checkout cannot tell apart.
 *
 * Folding can only ever add a refusal, never remove one, and it cannot produce a false one about
 * awcli's own names: a run name and a slot are refused unless they are already lowercase
 * (`firstProblem`, `not-lowercase`), so awcli never asks about a ref whose case could vary. What is
 * left is an operator's own branch, reported back in the spelling they gave it — they have to be able
 * to find it.
 */
function branchCollision(
  branch: string,
  runName: RunName,
  existing: readonly string[],
): BranchCollision | undefined {
  const short = (ref: string): string => printable(ref.slice("refs/heads/".length));
  const matching = (candidate: string): string | undefined => {
    const wanted = `refs/heads/${candidate}`.toLowerCase();
    return existing.find((ref) => ref.toLowerCase() === wanted);
  };

  const same = matching(branch);
  if (same !== undefined) return { kind: "same", ref: short(same) };
  for (const candidate of workspaceBranchPrefixes(runName)) {
    const prefix = matching(candidate);
    if (prefix !== undefined) return { kind: "prefix", ref: short(prefix) };
  }
  const beneath = `refs/heads/${branch}/`.toLowerCase();
  const below = existing.find((ref) => ref.toLowerCase().startsWith(beneath));
  if (below !== undefined) return { kind: "below", ref: short(below) };
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
async function collisionMessage(
  git: GitRunner,
  repositoryPath: string,
  collision: BranchCollision,
  branch: string,
  runName: RunName,
  target: string,
): Promise<string> {
  if (collision.kind === "same") {
    // Which command to name is the same question `occupiedMessage` asks, and it has to be asked
    // here too: this path is only reached once the `occupied` check has established that nothing is
    // at the target, so the live cases are a registration whose directory has already been deleted
    // — where `git worktree remove` is exactly right — and a branch nothing has ever held, where it
    // exits 128 with `fatal: '<path>' is not a working tree`. Naming the removal "first"
    // unconditionally told the second operator that the command they need is blocked behind one
    // that refuses. `unknown` names both, and claims neither.
    const held = await worktreeRegistration(git, repositoryPath, target);
    const remedy =
      held === "registered"
        ? `If it is finished with, remove the working copy that holds it first with "git worktree remove ${target}" (which works even if that directory has already gone, and "git worktree prune" clears every stale registration at once), then "git branch -D ${branch}".`
        : held === "unregistered"
          ? `If it is finished with, "git branch -D ${branch}" deletes it — git has no working copy registered at ${target}, so there is nothing to remove first.`
          : `If it is finished with, "git branch -D ${branch}" deletes it; if git refuses because a working copy still holds it, "git worktree remove ${target}" clears that registration first ("git worktree prune" clears every stale one at once). awcli could not ask git which of the two this is.`;
    return `awcli will not cut the branch ${branch} for the "${runName}" run: it already exists, and awcli never moves or deletes a branch — the commits on one are the deliverable. ${remedy} Or run this under a different --name.`;
  }
  const where =
    collision.kind === "prefix"
      ? `the branch ${collision.ref} already exists, and git cannot hold a branch and a directory of branches at the same name`
      : `the branch ${collision.ref} already exists beneath it, and git cannot hold a branch and a directory of branches at the same name`;
  return `awcli cannot cut the branch ${branch} for the "${runName}" run: ${where}. That branch is not one of awcli's — awcli only ever creates branches under ${BRANCH_NAMESPACE}/<run>/<slot> — so rename or delete it, or run this under a different --name.`;
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
          `awcli could not read the commit the working copy at ${dir} is on: git rev-parse exited ${answer.code}. ${gitComplaint(answer.stderr)}`,
        );
      }
      return answer.stdout.trim();
    },
    dirty: async () => {
      const answer = await run(git, ["status", "--porcelain"], dir);
      if (answer.code !== 0) {
        throw new Error(
          `awcli could not tell whether the working copy at ${dir} has uncommitted changes: git status exited ${answer.code}. ${gitComplaint(answer.stderr)}`,
        );
      }
      return answer.stdout.trim().length > 0;
    },
  };
}

/**
 * The sentence an operator reads about what they got (BR-015).
 *
 * It names the bound of what is protected as well as what is protected, and that is the rule rather
 * than caution: "sandbox" and "worktree" both read as a machine boundary and neither is one. What it
 * must not do is state the *other* axis's answer. The filesystem outside the repository, the network
 * and this machine's credentials named as reachable are all properties of running on the host, and
 * this type carries no execution target — deliberately, for the reason `WorkspaceIsolation` gives.
 * The BR-015 scenario that wants that sentence is scoped to an agent running *without a container*,
 * and a worktree composed with one (AWCLI-19) would reuse this description to tell the operator their
 * credentials are reachable inside a container that blocks them. So each axis says its own half, and
 * whatever composes them into the contract's `Isolation` says both.
 */
function describe(workspace: WorkspaceAxis, dir: string, branch: string): string {
  return workspace === "liveTree"
    ? `Working directly in your own checkout at ${dir}, on your branch ${branch}, because this run was given ${LIVE_CHECKOUT_FLAG}: uncommitted changes there are an agent's to change, and nothing about the working copy protects them. What an agent can touch beyond your checkout is settled by where this run executes, not by the working copy it was given.`
    : `Working in a worktree at ${dir}, on the branch ${branch}: your own checkout, its branch and its uncommitted changes are untouched, and awcli ran none of the repository's git hooks to make it. That is the whole of what a working copy protects — it is not a boundary around the machine, and what an agent can touch beyond this directory is settled by where this run executes, not by the working copy it was given.`;
}

/**
 * git, with the cases that are not an answer turned into faults.
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
  if (outcome.kind === "no-such-directory") {
    // The preflight established that this directory exists, so it has gone since — a run's own
    // repository being removed underneath it is a fault, not something to offer a flag for.
    throw new Error(
      `awcli could not run git in ${cwd}: that directory is no longer there, and it was when this run started.`,
    );
  }
  return outcome;
}

/**
 * Refuses a symlink anywhere between the repository root and a run's worktree directory.
 *
 * Named `assert*` rather than `refuse*`: this throws a plain `Error`, which is the *fault* channel,
 * and `refuse`/`refuseWith` produce a `WorkspaceRefusal`, which is the operator-fixable one. Sharing
 * the verb across the two put the file's central distinction in the one place a maintainer copies
 * from — a new guard shaped like this one, expected to produce a refusal, ships a throw the gate
 * chain cannot print as a remedy.
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
async function assertNoSymlinkedAncestors(
  repositoryPath: string,
  runName: RunName,
): Promise<void> {
  for (const ancestor of worktreePathAncestors(repositoryPath, runName)) {
    const stats = await lstatOrMissing(ancestor);
    if (stats === undefined) return;
    assertUsableDirectory(ancestor, stats);
  }
}

/**
 * Creates the directories above a working copy, one level at a time, checking each as it goes.
 *
 * `mkdir` with `recursive` was what this did, and it is the wrong call twice over: it *follows* an
 * existing symlink at any level, and it creates every level in one act — so a link planted at
 * `.awcli` after the check above had awcli create the run's whole directory tree inside the link's
 * destination, and only then did the second check look and throw. awcli had already written outside
 * the repository by the time it refused. Verified with node: `mkdirSync` through a symlinked
 * intermediate creates the leaf at the link's destination.
 *
 * Non-recursively, level by level, is what makes the refusal precede the writing: `mkdir` never
 * follows a *final* symlink, so a link at this level answers EEXIST rather than being created
 * through, and the `lstat` that follows says what is there before the next level is attempted. That
 * is still check-then-use for the level below — nothing available in node makes it one act — which
 * is why `assertInsideRuntimeDirectory` asks git's finished work where it actually landed. Between
 * them, the window is narrowed to one level at a time and closed after the fact.
 */
async function makeLayout(repositoryPath: string, runName: RunName): Promise<void> {
  for (const ancestor of worktreePathAncestors(repositoryPath, runName)) {
    try {
      await mkdir(ancestor);
    } catch (error) {
      // EEXIST says nothing about *what* exists there, which is the question below.
      if (!isErrno(error, "EEXIST")) {
        faultOnUnwritable(error, dirname(ancestor));
        throw error;
      }
    }
    const stats = await lstat(ancestor);
    assertUsableDirectory(ancestor, stats);
  }
}

/** A component of the layout awcli can use: a real directory, and not a link to one. */
function assertUsableDirectory(ancestor: string, stats: Stats): void {
  if (stats.isSymbolicLink()) {
    throw new Error(
      `${ancestor} is a symbolic link, and awcli will not follow one to reach a run's working copies: the working copy, and everything an agent writes in it, would land outside the repository. Remove it and run again.`,
    );
  }
  // Anything else that is not a directory, which is the sibling case and used to have no sentence
  // at all: `lstatOrMissing` turns ENOENT into "not there" and rethrows every other errno as it
  // came, so a repository carrying a tracked file named `.awcli` produced `ENOTDIR: not a
  // directory, lstat ...` and a stack trace from the *next* iteration's lstat. Named here, at the
  // component that is actually the problem — a message about `.awcli/run` would send the operator
  // looking for a path that cannot exist.
  if (!stats.isDirectory()) {
    throw new Error(
      `${ancestor} is a file, and awcli needs a directory there to hold this run's working copies. awcli never writes over what it finds: move or remove it and run again.`,
    );
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
 * `faultOnUnwritable`, not `refuseUnwritable`: it throws. See `assertNoSymlinkedAncestors`.
 *
 * The same failure `run-lock.ts` explains for the run directory, one directory along: an unwritable
 * repository is the one fault on this path an operator can fix without knowing anything about awcli,
 * and an `EACCES` with a stack trace does not tell them so.
 */
function faultOnUnwritable(error: unknown, directory: string): void {
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

/**
 * Swallows a failure to tidy up.
 *
 * Only for removing the empty directory awcli itself just created, on a path where the outcome is
 * already decided and already a failure. An exception from here would replace the error that says
 * what actually went wrong — the same reasoning `run-lock.ts` gives for its own staging files.
 */
function ignoreCleanupFailure(): void {}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
