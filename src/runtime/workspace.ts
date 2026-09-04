import type { Stats } from "node:fs";
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
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
 *     workflow cannot obtain one — nothing routes workflow input into the resolver today, and three
 *     tickets between them are the call sites that could change that: AWCLI-05 loads the workflow,
 *     AWCLI-20 parses the flag, AWCLI-19 builds `ctx.sandbox`. This named only AWCLI-20, and naming
 *     one of three is how the rule ended up deferred to a ticket that did not carry it.
 *     `LiveCheckoutConsent` sets out the three properties one at a time and says which ticket holds
 *     which half; read that before relying on this paragraph.
 *   - **The branch and the path are pure functions of the run name and the slot** (BR-036). A
 *     resumed run finds what it made by deriving the name again, so a timestamp or a counter
 *     anywhere near either would leave a branch per iteration behind and make AWCLI-14's
 *     reattachment impossible. See `workspaceBranch` in run-identity.ts.
 *   - **Provisioning is never destructive.** awcli never runs `git worktree remove`, never passes
 *     `--force`, and never resets, checks out over an existing tree or cleans. Anything already at
 *     the target path is a refusal that leaves it exactly as it was — AWCLI-14 turns that refusal
 *     into first-class reuse, and until it lands, refusing is the only answer that cannot destroy
 *     work. Two things this file does remove, both of them its own and both bounded by a proof
 *     rather than by an intention: the empty directory it created moments earlier when git then
 *     failed (`rmdir` refuses a directory with anything in it, which is what holds it to "empty"),
 *     and the branch its own `git branch` cut when the `git worktree add` after it then failed —
 *     `undoOwnBranch` deletes that one, and the proof is the exit status rather than the ref: git
 *     refuses a name that already exists, so a zero exit from the cut is what establishes that the
 *     ref is awcli's and nobody else's. Reading the sha back could not have established it, which
 *     is why the two calls are split at all; see the note at the call site. Both removals are best
 *     effort, and the fault names what actually went back rather than implying either did — which
 *     is the honest version of a promise this docblock used to make unconditionally. `Undone` has a
 *     third answer for the delete, because "what went back" is a claim about what git said and two
 *     of the five failure shapes are a git that never ran: see `Undone.branch`. A
 *     `git worktree add` killed by a signal (the OOM case `git-process.ts` documents at length) is
 *     the state where neither works: it leaves a part-checked-out target, a registration git holds
 *     `locked initializing`, and the branch, and in that state `rmdir` fails with ENOTEMPTY and
 *     `git branch -D` exits 1 because a working copy still holds the ref. Measured on git 2.55.
 *     awcli cannot clear a locked registration — `git worktree remove` refuses one, `--force`
 *     included — and does not claim to have; `undoOwnBranch` reports what it managed and the
 *     message names the leftovers and the commands that do clear them. Leaving that branch
 *     behind is what is destructive: it made the run and slot permanently unusable and told the
 *     operator a branch they had never seen was in the way. Note also that the refusals *advise*
 *     `git worktree remove` and `git branch -d`: what awcli will not do on its own, an operator may
 *     well want to do, and the message's job is to name a command that works — `-d` and never `-D`,
 *     because a refusal is not the place to hand someone a command that discards commits.
 *
 * awcli runs none of the repository's *hooks*, on every git call that can run one — four of them
 * today, reaching three hook names between them. `git branch` updates a ref and a ref update runs
 * `reference-transaction`, and so does `undoOwnBranch`'s delete on the failure path; `git worktree
 * add` performs a checkout and a checkout runs `post-checkout`; and `dirty()`'s `git status` writes
 * the index whenever it has to refresh stat information, and writing the index runs
 * `post-index-change`. All three hooks resolve through the *shared* git dir and through the shared
 * config's `core.hooksPath`, neither of which is per-worktree — so the moments awcli acts with the
 * operator's identity, before any execution boundary exists, would be handing execution to a file
 * any agent in any slot can have written. Every one of the four carries `NO_HOOKS`, and `describe`
 * says so, because "the worktree protects your checkout" is not a claim to make while making the
 * worktree — or reading it — ran the repository's code.
 *
 * "On every git call that *mutates the repository*" is what this said, and the scope is the part
 * that has now been wrong twice in the same paragraph. The `reference-transaction` half arrived with
 * the split of `git worktree add -b` into a `git branch` of its own and was missed for a commit,
 * which is what moved the rule from hook names to calls. `post-index-change` was missed because
 * `dirty()` mutates the *index* and not the repository, so a rule scoped to repository mutations
 * excused the one call an agent can reach repeatedly and at will — later than provisioning, for the
 * whole life of the run, and after AWCLI-25's boundary is supposed to be what stands between an
 * agent and the host. Scoping the rule to what can run a hook is what makes it hold for a call
 * nobody has thought of yet.
 *
 * Hooks specifically, and not "no code at all", which is what this claimed and which is false. Two
 * routes stay open, and *when* each applies matters as much as that it exists:
 *
 *   - The checkout runs `filter.<driver>.smudge` for every path `.gitattributes` assigns to a
 *     driver, and the driver's command is a shell string read from the *same* shared `.git/config` —
 *     which an agent reaches from inside any worktree with a plain
 *     `git config filter.x.smudge '<cmd>'`, no path knowledge needed. That is one command, at
 *     provisioning time.
 *   - `dirty()` runs `filter.<driver>.clean`, on the same `.gitattributes` and the same shared
 *     config, for every assigned path whose stat information has changed. And `dirty()` is a
 *     `WorkspaceHandle` member: it is called for the whole life of the run, so this route is not a
 *     moment during provisioning but a command available on every question awcli asks about the
 *     working copy. This was recorded as `core.fsmonitor`, which is a second route and not the one:
 *     the clean filter is the route that needs no configuration an operator would notice, and it was
 *     named nowhere. Measured under awcli's exact argv, `filter.evil.clean` and `filter.evil.smudge`
 *     pointing at a script that appends to a marker file: `git -c core.hooksPath=/dev/null/...
 *     worktree add -q <t> -b <b>` wrote `RAN-smudge`, and
 *     `git -c core.hooksPath=/dev/null/... -c status.showUntrackedFiles=normal status --porcelain`
 *     wrote `RAN-clean` — run both from the repository and from inside the worktree, on git 2.55.
 *     `core.fsmonitor` ran in the same status invocation, and that route is now *closed*: `NO_HOOKS`
 *     pins `core.fsmonitor=` alongside the hooks path. It is the one of the three that closes for
 *     free — an fsmonitor is a performance cache and git falls back to scanning — so it is not part
 *     of the residual below, which is about the filters and them only.
 *
 * `NO_HOOKS` does not touch any of them: `core.hooksPath` governs hooks and says nothing about
 * filters, verified by the same run. Both are left open deliberately, and the reasoning is recorded
 * because the residual is the interesting part:
 *
 *   - Closing them costs correctness. Neutralising the drivers on the command line
 *     (`-c filter.<n>.smudge=`) checks out git-lfs *pointer files* instead of content, so an agent
 *     edits pointers and commits them as work — data loss produced by a defence. Refusing to
 *     provision while a driver is configured blocks every `git lfs install --local` repository, with
 *     no remedy that is not "reconfigure your machine".
 *   - Closing them buys nothing on this build. An agent here runs unsandboxed on the host with the
 *     operator's identity, so anything it could reach by planting a filter it can reach by running
 *     the command itself. There is no boundary yet for a filter to escape.
 *
 * It stops being free the moment AWCLI-19 puts a container around an agent: from then on the shared
 * `.git/config` is inside the boundary and awcli executes it outside, which is an escape. The
 * `clean` half is the worse one to inherit, and the reason is the *when* above: a smudge filter is
 * one command at provisioning, before the agent has run at all, so a container built after it cannot
 * be escaped by something the agent had not yet written. `dirty()` is called for the life of the run,
 * so a filter an agent plants inside the boundary is executed outside it on the next question awcli
 * asks. That is a requirement on AWCLI-19 rather than a note here, and it is written on that ticket — on AWCLI-19
 * and not on AWCLI-25, which is where review suggested it: AWCLI-25 is the *host* target and has no
 * boundary for a planted filter to cross, so a requirement about what a boundary must not permit
 * belongs to the ticket that builds one.
 * `NO_HOOKS` stays regardless, because it costs nothing and it also stops an operator's own
 * `post-checkout` running an install, or their `reference-transaction` auditing a branch, on every
 * provisioning.
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
 *     What preserves it is a rule on the tickets that could change it — and this paragraph named the
 *     wrong ticket and a requirement that ticket does not carry, which is the orphan class three of
 *     this PR's amendment rows exist to close, in the module the rule protects. AWCLI-20 is *not*
 *     where a workflow first gets loaded in-process: AWCLI-05 owns "transpile and import a TypeScript
 *     workflow file using a bundled loader", AWCLI-20's own Out of Scope defers loading to it, and
 *     AWCLI-05 blocks AWCLI-20 — so the window opens a wave before the ticket named as its guard. And
 *     what AWCLI-20 carries is narrower than what was claimed for it: `--live-checkout` is consumed
 *     at the flag boundary, resolved "through AWCLI-13's `resolveWorkspaceChoice` — not by a second
 *     decision taken here", and absent from `ctx.args`. That is a rule about *that* unit, not the
 *     stronger "handed down, never re-derived anywhere a workflow can reach".
 *
 *     Three tickets carry it between them, each the half it can enforce, and none of them alone is
 *     the sentence this used to assert. AWCLI-05 is where the window opens, and it now requires that
 *     a loaded workflow is called with the injected context and nothing else, so the loader adds no
 *     channel of its own — the half no ticket held. AWCLI-20 is the command line, and takes the
 *     decision there rather than twice. AWCLI-19 is `ctx.sandbox`, the one member that routes a
 *     workflow's own input at a working copy, and it fixes both isolation axes at construction with
 *     `SandboxOptions` carrying a slot name and nothing else. Binding the consent to the run name
 *     instead was considered and is not the answer: a workflow knows its own run name, so it would
 *     satisfy the check as readily as the CLI does, and the ceremony would read as a guarantee where
 *     the call-site rules are the whole of it.
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
  /**
   * What is and is not protected, for the operator and the log (BR-015).
   *
   * A paragraph, not a line — 351 characters for the live-checkout axis and 634 for the worktree one,
   * measured with a plausible repository path (`/Users/you/code/repo`), so four and seven wrapped
   * terminal lines at 100 columns. It said "one line", which is the kind of claim AWCLI-21 discovers
   * is false at print time: that ticket states this once for the run *and* once per agent call, and
   * three parallel agents each restating the same few hundred characters of bounding prose is the
   * terminal rather than a line in it. The numbers move with the wording, so what has to stay true is
   * the shape rather than the count — the contract says "a short paragraph" for that reason. Deciding
   * it here is cheaper than deciding it there. What AWCLI-21 needs and does not have yet is a short
   * per-call form; this field is the long one, for the run header, and splitting it belongs to the
   * ticket that has both call sites in hand.
   */
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
  /**
   * git is on the machine and could not be started for this call — the errno says why.
   *
   * Its own kind rather than `git-unavailable`, because the remedy is disjoint: `git-unavailable`
   * says "install git, or put it on the PATH", and for an `EACCES` on a repository directory the
   * operator cannot enter, that advice cannot work on a machine where git is already working.
   */
  | "git-not-started"
  /**
   * A second concurrent working copy was asked for on the live checkout, which has only one.
   *
   * BR-013 says concurrently-running agents each get their own working copy on their own branch, and
   * records "Exceptions. None." The worktree axis satisfies it by construction — path and branch are
   * both pure functions of run and slot — but the live checkout has one directory and one branch
   * whatever the slot is called, so nothing but a refusal can hold the rule there. Without it,
   * `--live-checkout` plus two slots handed two agents the same tree and the same branch, silently,
   * which is the exact sharing BR-013 exists to forbid.
   */
  | "live-checkout-already-held"
  /** The path awcli was pointed at is not a git repository. */
  | "not-a-repository"
  /** The repository has no commit, so there is no branch to cut a working copy from. */
  | "no-commit"
  /** The repository has no working tree — a bare one — so a run has nowhere to keep anything. */
  | "no-working-tree"
  /** The live checkout is on a detached HEAD, so it has no branch to report. */
  | "detached-head"
  /**
   * The branch this slot derives already exists. Reattaching to it is AWCLI-14's.
   *
   * Four states, and `detail.collision` is what tells them apart — one of them has no remedy in a
   * different `--name`. See `WorkspaceRefusalDetail`.
   */
  | "branch-exists"
  /**
   * Something is already at the target path. Left exactly as it was; reuse is AWCLI-14's.
   *
   * Also the answer for a path another acquisition is provisioning onto *right now*, whose remedy is
   * the opposite one — wait, touch nothing. `detail` is what separates them; see
   * `WorkspaceRefusalDetail`.
   */
  | "occupied";

/**
 * The finer answer behind `kind`, for the two kinds that fold several states together.
 *
 * `kind` alone is not enough on either, and for the same reason both times: this module computes a
 * finer answer to decide what the *sentence* says and then dropped it on the way out, so anything
 * downstream — the gate chain deciding whether to suggest a retry, AWCLI-14 deciding whether an
 * existing branch is reattachable, a caller reporting a run's outcome — had to string-match operator
 * prose to recover it. The refusal shape is contract surface, so the place to widen it is here
 * rather than in the ticket that will consume it.
 *
 * The `occupied` arm carries *both* the discovery and git's answer about the path, and the pairing is
 * the point rather than completeness: `occupancy` on its own reproduces at the machine-readable layer
 * the exact defect the prose was corrected for. A racing loser reaches the `found` site whenever the
 * winner's `mkdir` lands before its own `lstat`, so "another run is provisioning here" is not
 * `occupancy === "raced"` — it is `raced` *or* a registration git has marked `locked initializing`.
 * A consumer switching on the discovery alone would clear a live winner's working copy.
 */
export type WorkspaceRefusalDetail =
  | {
      readonly kind: "occupied";
      /** How awcli found out the path was taken. See `Occupancy`. */
      readonly occupancy: Occupancy;
      /**
       * What git says is registered at the path, or `undefined` where awcli did not ask — the
       * `raced` discovery refuses without a git call, because EEXIST from awcli's own `mkdir` is
       * already the strongest evidence there is that another writer is working right now.
       */
      readonly registration: WorktreeRegistrationAnswer | undefined;
    }
  | {
      readonly kind: "branch-exists";
      /** Which ref is in the way, and so whether a different `--name` is a remedy at all. */
      readonly collision: BranchCollision["kind"];
    };

export interface WorkspaceRefusal {
  readonly ok: false;
  readonly kind: WorkspaceRefusalKind;
  /**
   * The finer answer behind `kind`, where there is one. See `WorkspaceRefusalDetail`.
   *
   * Absent rather than invented on the kinds that fold nothing together — an invalid slot, a
   * repository with no commit — because a `detail` a consumer can switch on and learn nothing from
   * is worse than no field at all.
   */
  readonly detail?: WorkspaceRefusalDetail;
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
  /**
   * Substituted in tests for the faults a real repository cannot stage. The default runs git.
   *
   * It is a test seam on a request object, and the asymmetry with `LiveCheckoutConsent` two fields
   * up is worth naming rather than leaving to be found. That field spends sixty lines making it
   * impossible for a request to decide the workspace axis — a module-private frozen sentinel, an
   * identity check, an unspellable brand — and this one is a plain optional function that decides
   * strictly more: a supplied runner answers `rev-parse --show-toplevel`, and the `root` that comes
   * back is what `worktreePath`, `makeLayout`, `mkdir`, `assertNoSymlinkedAncestors` and
   * `assertInsideRuntimeDirectory` are all derived from, while the real `mkdir`/`rmdir`/`realpath`
   * execute against whatever path it named. So the boundary is compared against a value the caller
   * chose.
   *
   * What makes that safe today is a fact about the call sites rather than a property of the type:
   * nothing routes workflow input into `acquireWorkspace`, because `ctx.sandbox` is unbuilt
   * (`DELIVERED_BY.sandbox` points at AWCLI-19). That is the same weakest-property admission the
   * consent docblock makes about itself — and the consent has a written call-site rule for the
   * ticket that changes it while this had none. It has one now: AWCLI-20's Constraints say this
   * field is never populated from anything a workflow or an invocation can reach, with a criterion
   * that watches which runner an acquisition is given. Branding it instead was considered and
   * declined: the brand would have to be spellable by every test in eight suites, which makes it a
   * naming convention rather than a guarantee, and the guarantee that is actually available is a
   * rule on the one unit that turns invocation input into awcli's own values.
   */
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

  // `detail` is spread in rather than assigned, because `exactOptionalPropertyTypes` distinguishes
  // an absent optional field from one present and undefined — and the distinction is the one the
  // field's docblock makes: a refusal that folds nothing together carries no discriminator, rather
  // than carrying an empty one.
  const refuseWith = (
    kind: WorkspaceRefusalKind,
    slot: string,
    message: string,
    detail?: WorkspaceRefusalDetail,
  ): WorkspaceRefusal => ({
    ok: false as const,
    kind,
    run: runName,
    slot,
    message,
    ...(detail === undefined ? {} : { detail }),
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

  // The live checkout this acquisition claimed, if it claimed one — read by `release` and by nothing
  // else. `undefined` for every worktree acquisition, which claims nothing here.
  let held: string | undefined;

  // The refusal travels on the error and nowhere else. `open` either returns a handle or throws,
  // there is no third channel through the stack, and `DisposalStack.acquire` rethrows what `open`
  // threw unchanged — so the catch below reads the refusal off the error it caught. A copy held in a
  // binding out here would be read by a future edit *instead* of the error, and a path that reaches
  // it without the throw having happened would report success on a refused run.
  const refuse = (
    kind: WorkspaceRefusalKind,
    message: string,
    detail?: WorkspaceRefusalDetail,
  ): never => {
    throw new WorkspaceRefusedError(refuseWith(kind, slot, message, detail));
  };

  const acquisition: Acquisition<WorkspaceHandle> = {
    name: WORKING_COPY_RESOURCE,
    // Preserved, never destroyed: an interrupted run's work has to still be on disk to inspect, and
    // its branch carries the commits that are the whole deliverable (BR-021, BR-036).
    disposition: "preserve",
    open: async () => {
      // Inside `open`, with the seven that need git, and that is the point rather than an accident of
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
      // Read once, before any `await`, and everything below uses the locals.
      //
      // `choice` is a caller-supplied object and these two fields were read twice each, either side
      // of `sharedPreflight`'s awaits: the check below, then the dispatch after it. A `choice` whose
      // `workspace` is a getter — or any object mutated by a concurrent turn between the two reads —
      // answered "worktree" to the consent check and "liveTree" to the dispatch, which put an agent
      // in the operator's checkout without a consent token being forged at all. The token's identity
      // check is sound; it was simply not the value the dispatch consulted. One read, one decision.
      // One destructure, which reads each property exactly once. A narrowing `&&` cannot do it:
      // `choice.workspace === "liveTree" && choice.consent !== OPERATOR_CONSENT` is two reads by
      // construction, and the union makes `consent` unreachable without narrowing — so the read is
      // taken through a widened view of the same object, which is the only shape that reads both
      // fields once. Holding a reference instead (`const c = choice`) would not help: a getter
      // re-evaluates on every property access, and the reference is the same object.
      const { workspace, consent } = choice as {
        readonly workspace: WorkspaceChoice["workspace"];
        readonly consent?: LiveCheckoutConsent | undefined;
      };
      const wantsLiveTree = workspace === "liveTree";
      if (wantsLiveTree && consent !== OPERATOR_CONSENT) {
        refuse(
          "live-checkout-not-consented",
          `awcli will not work in your checkout at ${printable(repositoryPath, PATH_LIMIT)} for the "${runName}" run: working there is the operator's decision and this run has no ${LIVE_CHECKOUT_FLAG} from one. Nothing was provisioned, and awcli has not silently used a worktree instead — run it again with ${LIVE_CHECKOUT_FLAG} to work in your checkout, or without it to have awcli provision a worktree.`,
        );
      }
      const { root, head } = await sharedPreflight(git, repositoryPath, refuse);
      if (!wantsLiveTree) {
        return await openWorktree(git, root, runName, slot, head, refuse);
      }
      // BR-013, which the live checkout cannot satisfy by construction the way the worktree axis
      // does. Claimed after the preflight because `root` is what the key is built from, and before
      // `openLiveTree` so that a refused second slot reads no branch and touches nothing.
      const key = `${root}\u0000${runName}`;
      if (liveCheckoutsHeld.has(key)) {
        refuse(
          "live-checkout-already-held",
          `awcli will not give the "${slot}" slot your checkout at ${printable(root, PATH_LIMIT)} for the "${runName}" run: this run already has it, and a checkout is one working copy on one branch however many slots ask for it. Two agents in there would overwrite each other's work with no record of which result is which, so awcli refuses rather than sharing it. Nothing was provisioned and your checkout is untouched. Run the agents that need their own working copy without ${LIVE_CHECKOUT_FLAG} — awcli provisions each a worktree of its own — or run them one after another.`,
        );
      }
      liveCheckoutsHeld.add(key);
      held = key;
      return await openLiveTree(git, root, slot, refuse);
    },
    // Nothing *on disk*. A working copy is preserved, so there is nothing to undo — and for a live
    // checkout this is the whole point: releasing it must not touch the operator's tree in any way at
    // all. The registration exists for the report, not for an effect. See the docblock above.
    //
    // The one thing it does release is awcli's own in-memory claim on the live checkout, which is
    // not the tree and not on disk: holding it past release would make BR-013's rule about
    // *concurrent* agents into a rule about the whole life of a process.
    release: () => {
      if (held !== undefined) {
        liveCheckoutsHeld.delete(held);
        held = undefined;
      }
    },
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
 * The bound for a value the operator is meant to copy: a path inside a command, or a ref they are
 * told to rename or delete.
 *
 * `PATH_LIMIT` is the wrong one there: `printable` truncates with an ellipsis, and an ellipsis inside
 * `git worktree remove /some/tru...` is a command that runs and does the wrong thing. `PATH_MAX` is
 * 1024 on macOS — measured with `getconf PATH_MAX /` on the Darwin this is developed on, not the 4096
 * this comment used to assert of "every platform awcli runs on" — and 4096 on Linux, so this bound is
 * above anything either filesystem can hand back. It is here so a hostile value cannot flood the
 * terminal, not to shorten real values, which is why it is a round number well clear of both rather
 * than either of them.
 *
 * The same reasoning covers a ref, which is why `branchCollision`'s `short` uses this and not
 * `PRINTABLE_LIMIT`: the `namespace`, `prefix` and `below` refusals interpolate a branch name into
 * "so rename or delete it", and a name with `...` in the middle of it is a name the operator cannot
 * act on. It was reachable rather than theoretical — a run name may be 64 characters
 * (`MAX_NAME_LENGTH`), so the `prefix` collision ref `awcli/<run>` passes 64 at a 59-character run
 * name, and a `below` ref is longer again. Nothing bounds a ref at 4096 either: git's own limit is
 * per component through the filesystem, and a deep enough `refs/heads/a/b/c/...` exceeds any bound
 * short of one like this.
 */
const COMMAND_PATH_LIMIT = 4096;

/**
 * A path as a single shell argument, for a remedy the operator is meant to copy and run.
 *
 * Every `git worktree remove ${target}` in a refusal was unquoted, and the repository root is
 * whatever the operator's disk says: `~/My Projects/repo`, `~/Library/Application Support/...`.
 * Pasted into a shell the command split on the space and git answered with a usage error, so the
 * refusal named a remedy that does not run — the same class as naming the wrong command, one layer
 * down. Single quotes rather than backslashes because they need no knowledge of what else is in the
 * string: inside them every character is literal, and the one exception is escaped the standard way.
 */
function shellPath(path: string): string {
  return `'${printable(path, COMMAND_PATH_LIMIT).replaceAll("'", `'\\''`)}'`;
}

/**
 * Said when a path cannot be written down, because then every remedy above names a different path.
 *
 * `shellPath`'s quoting is correct — inside single quotes every byte is literal and the one exception
 * is escaped the standard way — and the quoting is not the defect. The *ordering* is: `printable`
 * runs first, and it maps each control character, bidi mark and zero-width character to `?`, which is
 * itself a perfectly legal filename character. So a newline in the repository root produces
 * `git worktree remove '<path with ? where the newline was>'` — a command that parses, addresses
 * something else, and exits 128 naming a path the operator has never seen. This module goes to some
 * trouble elsewhere (the `-z` parse of `worktree list --porcelain`) to be correct for a path
 * containing a newline, and then handed out a remedy that was not.
 *
 * Quoting the raw path instead is the fix that trades one defect for a worse one: it puts the control
 * character on the operator's terminal, in a refusal, which is the whole of what `printable` exists
 * to stop. So the sentence says what happened and names the command that prints the real bytes
 * rather than pretending the printed form is copyable.
 *
 * The limit passed is the path's own length, so this asks only whether the *substitution* changed
 * anything: `printable` replaces each character it takes out with a single `?` and non-BMP ones with
 * one `?` for two units, so a sanitised path is never longer than the original and this cannot trip
 * on the truncation. A path long enough to be truncated at `COMMAND_PATH_LIMIT` is a different
 * problem and not one a sentence fixes.
 *
 * Empty for every ordinary path, which is nearly all of them — a repository root with a space in it
 * is what `shellPath` is for, and it is unaffected. Watched by workspace-branches.test.ts, beside
 * the spaced-path test whose remedy it runs: there the pasted command works, here it is required to
 * fail before the sentence is asserted. And by the gate mutation that empties this.
 */
function unshowablePathNote(path: string): string {
  if (printable(path, path.length) === path) return "";
  return ` Every "?" in that path is a character awcli will not print: a directory name may hold any byte but NUL and "/", and a control character or a bidi mark in one repaints the terminal reading it. So the path above, and any command here that names it, addresses something other than the working copy — copy the real one out of "git worktree list" rather than from here.`;
}

/**
 * Where awcli points `core.hooksPath` so that no hook of the repository's can be found there.
 *
 * A path *under* `/dev/null`, which is a character device: nothing can exist beneath it and nothing
 * can create anything there, so this cannot become a directory an agent plants a hook in — which a
 * path inside the repository, or a temporary directory, could. That is the half of `NO_HOOKS` that
 * carries a security property rather than a convenience, and it is why the constant is exported:
 * `mkdir` of this path has to fail, and workspace-inherit.test.ts asserts that it does. Measured on
 * this machine (macOS 26.5, Darwin 25.5) — `mkdir -p` of it fails ENOTDIR, both from a shell and
 * from node's `fs/promises` with `recursive: true`. `/tmp/awcli-runs-no-hooks` is the plausible wrong
 * value and every suite was green over it; the gate mutation that substitutes it is what keeps this
 * sentence honest.
 *
 * Spelled once, so the value the tests can reach is the value git is given. Two spellings would let a
 * mutation move the argv and leave the constant the assertion reads.
 */
export const NO_HOOKS_PATH = "/dev/null/awcli-runs-no-hooks";

/**
 * The arguments that keep a git invocation from running the repository's hooks.
 *
 * git looks for the hook under `NO_HOOKS_PATH`, does not find it, and proceeds; verified against git
 * 2.55 on both hook *names* rather than on a count of call sites — the same `git branch` runs
 * `reference-transaction` without this and does not with it, and the same `git worktree add` runs
 * `post-checkout` without this and does not with it. Those two are what the two kinds of mutation
 * reach, so this sentence does not need editing when a third mutating call is added; the rule below
 * is what has to be applied to it.
 *
 * `core.fsmonitor=` is the second half, and it is not a hook path: `core.hooksPath` does not govern
 * it. Measured on git 2.55 with `core.hooksPath` pinned to exactly the value above, a
 * `core.fsmonitor` pointing at a marker script ran *twice* during
 * `-c status.showUntrackedFiles=normal status --porcelain` and twice again during `worktree add`; set
 * to the empty string on the same argv it ran neither time. The config lands in the shared
 * `.git/config`, which an agent reaches from inside any slot with a plain `git config
 * core.fsmonitor '<cmd>'` — so without this, one command from one slot bought host execution under
 * the operator's identity on every later `dirty()` and every later provisioning, of any run. That is
 * the direction BR-015 says must never happen: a command planted *inside* the boundary, executed
 * outside it, after the boundary is built. Unlike the content filters below it, closing this costs
 * nothing — an fsmonitor is a performance cache, and git falls back to scanning the working tree —
 * which is why it is closed here and they are deferred to AWCLI-19.
 *
 * Every git invocation that *can run a hook* takes it. That is the rule to apply when a call is
 * added here, and it is deliberately wider than the two narrower rules that stood here before, each
 * of which excused a real call. "The add takes it" was overtaken by the split of `git worktree add
 * -b` into a cut of its own, which added a mutating call the argument did not reach. "Every
 * invocation that mutates the repository" was overtaken by `dirty()`, which mutates the *index*
 * rather than the repository and runs `post-index-change` — the one call an agent can reach
 * repeatedly, for the whole life of the run. The module docblock records both misses; scoping the
 * rule to what can run a hook is what makes it hold for the call nobody has thought of yet.
 */
const NO_HOOKS: readonly string[] = [
  "-c",
  `core.hooksPath=${NO_HOOKS_PATH}`,
  "-c",
  "core.fsmonitor=",
];

/**
 * The live checkouts held right now, keyed by repository root and run.
 *
 * Module scope because that is the scope of the thing it protects: `ctx.sandbox` hands a workflow
 * several slots inside one run in one process, so two `sandbox()` calls under `--live-checkout` are
 * two acquisitions in *this* process and a set here sees both. It is not a lock and does not pretend
 * to be one — a second awcli process on the same checkout is AWCLI-07's run lock, not this.
 *
 * Keyed on the root git reported rather than on the path the caller passed, so two spellings of one
 * checkout are one entry. Released on `release`, which keeps the rule about *concurrent* agents and
 * lets a run that has finished with the checkout take it again.
 */
const liveCheckoutsHeld = new Set<string>();

/** Thrown out of the acquisition so an operator-fixable condition becomes a refusal, not a throw. */
class WorkspaceRefusedError extends Error {
  constructor(readonly refusal: WorkspaceRefusal) {
    super(refusal.message);
    this.name = "WorkspaceRefusedError";
  }
}

/** How a refusal is raised from inside the acquisition. Never returns. */
type Refuse = (
  kind: WorkspaceRefusalKind,
  message: string,
  detail?: WorkspaceRefusalDetail,
) => never;

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
  if (inside.kind === "not-started") {
    refuse(
      "git-not-started",
      // Named without a remedy of awcli's own beyond the errno, because the errno is the remedy:
      // EACCES is a directory the operator cannot enter, EAGAIN and EMFILE a machine out of
      // processes or descriptors, and awcli cannot tell which of those the operator can fix.
      `awcli cannot provision a working copy: ${inside.reason}. git is on this machine — it could not be started for this call, and the code in brackets is the reason the operating system gave. A permissions error names a directory awcli cannot enter; EAGAIN or EMFILE names a machine out of processes or file descriptors.`,
    );
  }
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
      `awcli found no directory at ${printable(inside.path, PATH_LIMIT)}, so it has nothing to make a working copy from. Check the path — awcli did not get as far as asking git about it.`,
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
      `awcli will not provision a working copy from ${printable(repositoryPath, PATH_LIMIT)}: that is not a git repository. Run awcli from a repository, or point it at one. git said: ${gitComplaint(inside.stderr)}`,
    );
  }

  // Where the repository *starts*, which is not necessarily where awcli was pointed. `rev-parse
  // --git-dir` exits 0 from every subdirectory, so `--repo /repo/packages/api` passed every check
  // above and then built the whole layout under the subdirectory: a second `.awcli/run` inside the
  // repository, holding a working copy the one generated ignore line (BR-030) does not cover, while
  // the branch was cut in the repository above. The layout follows from this answer; the path the
  // operator gave stays what git is asked *from*.
  // Two invocations rather than one, and that is a decision. `git rev-parse --git-dir --show-toplevel`
  // prints both answers from a single call and would save ~80ms per acquisition — but in a *bare*
  // repository the combined form exits 128 on the first question as well as the second (verified on
  // git 2.55: `fatal: this operation must be run in a work tree`, exit 128, with `.` still printed).
  // The check above would then report a bare repository as "that is not a git repository", which is
  // a confident sentence about a cause awcli never established, and it is the exact class of answer
  // the rest of this function is arranged to avoid. Two calls is what keeps the two exits apart.
  const top = await run(git, ["rev-parse", "--show-toplevel"], repositoryPath);
  const root = top.stdout.trim();
  if (top.code !== 0 || root.length === 0) {
    // A bare repository is the reachable case: it is a repository, so the refusal above does not
    // fire, and it has no working tree for `.awcli/run` to live in. Refused rather than thrown, which
    // is the correction: the operator's remedy is the same one `not-a-repository` gives — point awcli
    // at a repository with a working tree — and the gate chain prints a refusal as a remedy and a
    // throw as a stack trace. "No different flag to offer" was the reason given for the fault
    // channel, and it is the wrong test: what settles the channel is whether the operator can fix it,
    // and a mistyped `--repo` is theirs to fix whichever kind of repository it landed on.
    refuse(
      "no-working-tree",
      `awcli will not provision a working copy from ${printable(repositoryPath, PATH_LIMIT)}: git reports no working tree there, which is what a bare repository is. awcli keeps everything a run owns under <repository>/.awcli/run, so it needs a repository with a working tree — point it at a clone rather than at the bare one. git said: ${gitComplaint(top.stderr)}`,
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
      `awcli cannot cut a working copy from the repository at ${printable(root, PATH_LIMIT)}: it has no commit yet, so there is no branch to cut from. Make one commit and run again.`,
    );
  }
  if (head.code !== 0) {
    throw new Error(
      `awcli could not read the commit the repository at ${printable(root, PATH_LIMIT)} is on: git rev-parse HEAD exited ${head.code}. ${gitComplaint(head.stderr)}`,
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
    // version is stated in the README beside the Node one, and it is 2.36 rather than this call's
    // own 2.22 — `worktree list --porcelain -z` is what moved it. The sentence still names 2.22,
    // because what it explains is *this* exit status: an operator who reads it is on a git without
    // `--show-current`, and 2.22 is where that arrived.
    throw new Error(
      `awcli could not read which branch your checkout at ${printable(repositoryPath, PATH_LIMIT)} is on: git branch --show-current exited ${current.code}. ${gitComplaint(current.stderr)} awcli needs git 2.22 or later, which is where --show-current arrived.`,
    );
  }
  // Raw, and sanitised where it is *printed* rather than here. This is not a nicety about layering:
  // the value becomes `WorkspaceHandle.branch`, which is the contract field AWCLI-14 reattaches by
  // and BR-025 records the run against — not a string in a sentence. `printable` substitutes `?` for
  // every C0/C1 control, bidi mark and zero-width character and appends an ellipsis past its limit,
  // and of the *non-printing* characters git's ref rules ban only the C0 controls and DEL, so a
  // repository using a bidi mark or a zero-width space in a branch name had the handle naming a
  // branch that does not exist and a later `git checkout` of it failing. (git bans plenty besides —
  // space, `~`, `^`, `:`, `?`, `*`, `[`, `\`, `..`, a `.lock` suffix — and `run-identity.ts`
  // enumerates the ones awcli's own names meet; none of them is a character that renders as nothing.)
  //
  // Sanitising is still required, because the class is real: a branch called `main‮...` reverses the
  // rendering of everything after it in the BR-015 sentence, so the operator reads a line awcli did
  // not emit. It happens at each message that prints it — `describe`, which is the only one that
  // does — exactly as the refusal path already splits it: `branchCollision` compares raw refs and
  // `short` sanitises for the sentence.
  const branch = current.stdout.trim();
  if (branch.length === 0) {
    // `branch --show-current` answers with an empty line on a detached HEAD. Refused rather than
    // reported as an empty branch or as the commit id: a run's branch is what AWCLI-14 reattaches by
    // and what an operator reads, and neither of those has any meaning for a detached head.
    refuse(
      "detached-head",
      `awcli cannot say which branch this run worked on: your checkout at ${printable(repositoryPath, PATH_LIMIT)} is not on a branch. Check out a branch and run again, or leave ${LIVE_CHECKOUT_FLAG} off and let awcli provision a worktree.`,
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
    const occupied = await occupiedRefusal(
      git,
      repositoryPath,
      target,
      runName,
      branch,
      "found",
    );
    refuse("occupied", occupied.message, occupied.detail);
  }

  const namespaced = await namespaceRefs(git, repositoryPath);
  if (!namespaced.ok) {
    // Thrown rather than read as "nothing in the way". Every other git call in this module inspects
    // its exit status, and this one used its stdout unconditionally — but a non-zero exit yields
    // empty stdout, so an unreadable `packed-refs` was indistinguishable from a repository with no
    // awcli branches at all, and the run walked on into `git worktree add` to fail there with no
    // remedy. A question awcli could not get an answer to is a fault: there is nothing for the
    // operator to choose differently, and answering it wrongly is what costs them the refusal.
    //
    // Every way of not getting an answer, not only a non-zero exit. `namespaceRefs` is total now, so
    // a runner rejection — the read bound on a repository with hundreds of thousands of branches,
    // the timeout, a git that has gone — arrives here as `why` and lands in this sentence instead of
    // escaping as the runner's own line about bytes. See there for the measurement.
    throw new Error(
      `awcli could not list the branches in ${printable(repositoryPath, PATH_LIMIT)}, so it cannot tell whether ${branch} is free: ${namespaced.why}`,
      namespaced.cause === undefined ? undefined : { cause: namespaced.cause },
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
      await collisionMessage(
        git,
        repositoryPath,
        collision,
        branch,
        runName,
        target,
        // Nothing of awcli's has been created yet, so anything at the target is someone else's.
        "untouched",
      ),
      // The shape of the collision, which decides whether a different `--name` is a remedy at all
      // and which a consumer had to read out of the prose. See `WorkspaceRefusalDetail`.
      { kind: "branch-exists", collision: collision.kind },
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
      const occupied = await occupiedRefusal(
        git,
        repositoryPath,
        target,
        runName,
        branch,
        "raced",
      );
      refuse("occupied", occupied.message, occupied.detail);
    }
    faultOnUnwritable(error, dirname(target));
    throw error;
  }

  // The branch is cut by `git branch`, in its own call, and the working copy is checked out onto it
  // afterwards. `git worktree add -b <branch> <target> <sha>` did both, and the ordering inside it is
  // the defect: git creates the `-b` branch *before* it validates anything about the target path.
  // Verified on git 2.55 — a failing add prints `Preparing worktree (new branch 'awcli/triage/main')`,
  // then its `fatal:`, exits 128, and leaves `refs/heads/awcli/triage/main` behind. So on *every*
  // failing add the branch existed when awcli regained control, and awcli, re-asking the collision
  // question, refused `branch-exists` — "it already exists, and awcli never moves or deletes a branch
  // — the commits on one are the deliverable" — about a commitless branch it had cut 100ms earlier.
  // git's actual fatal was discarded with it, so the operator was never told the real cause
  // (permission denied, an unwritable `.git/worktrees`, a full disk), the branch was leaked, and the
  // run and slot stayed unusable on every later invocation until they deleted it by hand.
  //
  // Splitting the two calls is what makes the answer knowable rather than guessed. Telling "the
  // branch was already there" from "awcli's own add just made it" by inspecting the ref afterwards
  // cannot be done: a foreign branch planted in the window points at the same `head` sha awcli passed,
  // so the sha is not a proof of ownership, and git's announcement line is localised. Cutting the
  // branch first replaces the whole question with a ref transaction — `git branch` is atomic and
  // refuses a name that exists, so a non-zero exit here *is* the collision answer and a zero exit
  // means the ref is awcli's, with no inference in either direction.
  //
  // It costs one more git invocation than the combined form. That is the trade: `-b`'s "second line of
  // defence behind the check above" was real but it reported its findings unusably, and an atomic
  // claim is a stronger guarantee than a check-then-use pair however the failure is worded.
  //
  // The commit passed is the sha `sharedPreflight` already resolved — not the string `HEAD`, which is
  // the point. A sha pins what the working copy is cut from at preflight time; `HEAD` would be
  // re-resolved by git inside the same window the comments around here spend paragraphs closing, so a
  // commit landing on the operator's branch meanwhile would silently become what this run worked from.
  //
  // With `NO_HOOKS`, which the split made *more* load-bearing rather than less. Every ref update runs
  // `reference-transaction`, resolved through the shared git dir and the shared config's
  // `core.hooksPath` exactly as `post-checkout` is — so this call, not the add below, is now the first
  // mutating git invocation of a provisioning and the earliest point at which a file any agent in any
  // slot can have written would be handed execution on the host with the operator's identity. It
  // arrived here without the argument, which made `describe`'s "awcli ran none of the repository's git
  // hooks to make it" false for any repository carrying that hook. Verified on git 2.55 both ways:
  // `git branch <name> <sha>` runs it, the same call under this `core.hooksPath` does not.
  const cut = await run(git, [...NO_HOOKS, "branch", branch, head], repositoryPath).catch(
    async (error: unknown) => {
      await rmdir(target).catch(ignoreCleanupFailure);
      // Only for the shapes where git *ran*, which is the correction rather than a nicety. Five
      // rejections reach this handler and `run` raises two of them itself — `unavailable` (git could
      // not be started) and `no-such-directory` (the repository directory has gone) — and in both git
      // never ran, so no ref can exist and the residual below is a confident sentence about a state
      // awcli never established. It read worse than merely wrong on the second: it told the operator
      // to run `git branch --list` in a directory the same sentence has just said is no longer there.
      // `GitDidNotRunError` is what tells the two apart, by identity rather than by re-inspecting the
      // outcome, because the outcome is gone by the time this runs. Watched by the
      // `{unavailable, no-such-directory}` rows of `a branch cut that fails` in
      // workspace-fs-faults.test.ts, which assert the residual is absent, and by the gate mutation
      // that appends it unconditionally.
      if (error instanceof GitDidNotRunError) throw error;
      // The directory goes back and the branch cannot, so the fault says so. The three remaining
      // shapes are a git that ran: the 120s timeout, an answer past the read bound, a child killed by
      // a signal. In those the ref transaction may well have completed before the runner gave up on
      // it, and `undoOwnBranch` cannot be used to tidy it: its whole ownership proof is a zero exit,
      // which is exactly what did not arrive, so deleting on suspicion would be awcli deleting a
      // branch it cannot prove is its own — the one thing this module forswears. Named instead,
      // because the silent version costs the operator the next invocation of this run and slot: it is
      // refused `branch-exists` and told that the commits on a branch are the deliverable, about a
      // commitless branch awcli cut and abandoned.
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} awcli was cutting ${branch} when git stopped answering, so that branch may exist even though the working copy does not: "git branch --list ${branch}" says whether it does. awcli has not deleted it, because a git that did not answer is not a git that said the branch is awcli's.`,
        { cause: error },
      );
    },
  );
  if (cut.code !== 0) {
    await rmdir(target).catch(ignoreCleanupFailure);
    // Something claimed the name between the check above and this call. The conditions awcli has
    // sentences for were checked before the layout was made, and a check is not a guarantee — so the
    // question is put again, to the repository as it is now, and a branch that appeared meanwhile
    // gets the refusal already written for it rather than `git branch exited 128`.
    //
    // The `occupied` half of the same window needs no second look: `mkdir(target)` above is what
    // claims the path, and it fails with EEXIST rather than reaching here if anything — another
    // acquisition of this run and slot included — got there first.
    const late = await lateCollision(git, repositoryPath, runName, branch);
    if (late !== undefined) {
      refuse(
        "branch-exists",
        await collisionMessage(
          git,
          repositoryPath,
          late,
          branch,
          runName,
          target,
          // awcli made the target directory above and put it back a few lines up. See `TargetClaim`.
          "created-and-removed",
        ),
        { kind: "branch-exists", collision: late.kind },
      );
    }
    throw new Error(
      `awcli could not cut the branch ${branch} for the "${runName}" run: git branch exited ${cut.code}. ${gitComplaint(cut.stderr)}`,
    );
  }

  // With hooks off, which is not a detail: `git worktree add` performs a checkout, and a checkout
  // runs `post-checkout` — resolved through the *common* git dir and through `core.hooksPath` in the
  // shared config, neither of which is per-worktree. So the hook a run executes here is one any
  // agent in any slot of any run can have written, and provisioning is the moment before AWCLI-25's
  // execution boundary exists, with the operator's own identity. awcli's isolation prose is bounded
  // at what an agent reaches *from inside its working copy*; handing execution to a file in the
  // repository as part of making that working copy is outside what that sentence covers, so it does
  // not happen. See `describe` — and see the module docblock for the half `NO_HOOKS` does not close.
  //
  // No `--force` and no `--detach`. The branch is named rather than created, because it was created
  // above; `git worktree add <path> <branch>` checks it out and refuses if another working copy
  // already holds it, which nothing can, since this call is the only thing that has ever seen it.
  //
  // The `catch` and the `rmdir` are the same pair, for the same reason, on both exits. `run` throws
  // for a git that has gone missing and for a `cwd` that has; the raw runner throws for the 120s
  // timeout, for an answer past `maxBuffer`, and for a child killed by a signal — the OOM case
  // `git-process.ts` documents at length. On any of those, `mkdir(target)` has already claimed the
  // path, so without this the *next* invocation of this run and slot is refused `occupied` over
  // awcli's own empty leftover: the self-inflicted window this file keeps having to close.
  const added = await run(
    git,
    [...NO_HOOKS, "worktree", "add", target, branch],
    repositoryPath,
  ).catch(async (error: unknown) => {
    const undone = await undoOwnBranch(git, repositoryPath, branch, target);
    // Enriched the way the cut's own catch is, which this handler was not. Three of the shapes that
    // reach it are a git that *ran* — the 120s timeout, an answer past the read bound, and a child
    // killed by a signal, which is the OOM case `git-process.ts` documents at length — and in the
    // signal case git's cleanup handler does not run at all. Measured on git 2.55 by SIGKILLing an
    // add mid-checkout: three things are left, not the one this handler was written for. A
    // part-checked-out target, a registration git still holds and has marked `locked initializing`,
    // and the branch that registration holds. What was rethrown here was the raw runner line — `git
    // worktree add ... was killed by SIGKILL in <cwd>` — which names none of them, and awcli's
    // silence about its own tidying read as a claim that the tidying had worked. It had not: in that
    // state `rmdir` exits ENOTEMPTY and `git branch -D` exits 1. `undoneResidual` says which of the
    // two actually went back and names the commands that clear the rest; it says nothing when
    // nothing is left, which is the ordinary case for the other two shapes.
    const residual = undoneResidual(undone, branch, target);
    if (residual === "") throw error;
    // "Part-way through the checkout" only where git ran, which is the cut's own correction one
    // handler along: `run` raises `unavailable` and `no-such-directory` itself, and in both no add
    // process started, so a checkout that stopped part-way is a state awcli never established. The
    // *residual* stands on all five shapes and is why this handler still says something rather than
    // rethrowing — the cut exited zero, so the branch is certainly there, and `undone` is what says
    // whether the tidying took it back. Watched by the fs-fault suite's pair of runner-throw tests
    // and by the gate mutation that collapses the two arms into the confident one.
    const how =
      error instanceof GitDidNotRunError
        ? "and git never started the checkout"
        : "and git stopped part-way through the checkout";
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} awcli had already made ${printable(target, PATH_LIMIT)} and cut ${branch} for it, ${how}. ${residual}`,
      { cause: error },
    );
  });
  if (added.code !== 0) {
    // Both of awcli's own leavings go back, and the branch is unambiguously awcli's: `git branch`
    // above exited zero, which it does only when it created the ref. The empty directory goes only
    // while it is still empty — `rmdir` is what makes that a property rather than an intention, since
    // it refuses a directory with anything in it, including an add that got far enough to write
    // something before failing, which is git's to account for and not awcli's to delete.
    const undone = await undoOwnBranch(git, repositoryPath, branch, target);
    // Nothing awcli has a sentence for, then. Thrown rather than refused: a refusal claims awcli
    // knows what is wrong and what to do instead, and here it knows neither — but git does, and this
    // is the sentence that carries what it said, which the old `branch-exists` refusal replaced.
    //
    // The residual is appended and not led with, because on this exit it is almost always empty: git
    // that exits non-zero has cleaned up after itself, so both halves of the tidying succeed and
    // `undoneResidual` says nothing. When they do not, the leftover is what makes the next invocation
    // of this run and slot unusable, so it belongs in the same sentence as git's complaint rather
    // than in a fault the operator sees one run later.
    const residual = undoneResidual(undone, branch, target);
    throw new Error(
      `awcli could not create a working copy at ${printable(target, PATH_LIMIT)} for the "${runName}" run: git worktree add exited ${added.code}. ${gitComplaint(added.stderr)}${residual === "" ? "" : ` ${residual}`}`,
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
  await assertInsideRuntimeDirectory(repositoryPath, target, branch);

  return handle(git, target, branch, slot, "worktree");
}

/**
 * Refuses a working copy that is not, in fact, where awcli put it.
 *
 * The boundary is built from the *repository root* resolved, plus the layout spelled out — not from
 * `realpath` of the worktrees directory, which is what this did and which resolved the boundary
 * through the very link it exists to catch. Both sides were resolved after the working copy existed
 * and through the same layout, so a link planted at `.awcli`, at `.awcli/run` or at `worktrees`
 * itself moved the boundary along with the target and the comparison succeeded on the far side of the
 * escape. Only a link at `worktrees/<run>` or at the leaf was caught, and the leaf was the only case
 * the suite staged. Reproduced against git 2.55 by renaming `worktrees` out of the repository and
 * symlinking it back: `handle.dir` said `.awcli/run/worktrees/<run>/<slot>`, the working copy and the
 * agent's files were outside the repository, and nothing threw.
 *
 * The repository root is the one component that cannot itself be the escape: it is git's own
 * `--show-toplevel` answer and it exists before awcli creates anything, so resolving it is a question
 * about the operator's disk rather than about anything a racing writer put there. The layout suffix
 * comes from `worktreesRoot` via `relative`, so the layout stays declared in one place.
 *
 * Equality, not a prefix, and that is the correction of the version this replaced. A prefix test
 * answers "is it somewhere under the boundary", and the property this guard exists for is narrower:
 * that the path awcli checked and the path git used are *the same path*. A link at
 * `worktrees/<run>` pointing at `worktrees/<other>` resolves to somewhere that still starts with the
 * boundary, so the prefix test passed while `handle.dir` reported `.awcli/run/worktrees/<run>/<slot>`
 * and the working copy sat at `.awcli/run/worktrees/<other>/<slot>` — the exact mismatch the fault
 * channel exists to catch, unreported because it happened to land inside. It cannot put two live runs
 * in one tree (`mkdir(target)`'s EEXIST and the occupied `lstat` serialise that) and it is only
 * reachable in the window after `makeLayout`, which is why it is a strengthening rather than a
 * scramble. Equality also subsumes the two weaknesses the prefix form needed handling for — a
 * sibling whose name merely starts with `worktrees` (`.awcli/run/worktrees-elsewhere/x` passed the
 * separator-less prefix test) and everything below the boundary that is not this slot — so there is
 * one comparison rather than a prefix plus a trailing separator plus the cases neither covers.
 *
 * The expected path is derived the same way the boundary was: the repository root resolved, plus the
 * layout's own spelling of the target via `relative`. Nothing is hard-coded here and the layout stays
 * declared in `run-identity.ts`. A `realpath` that fails is refused too; this is the check that says
 * where the working copy is, and "awcli could not tell" is not an answer to hand back as a handle.
 *
 * It is also the only failure exit in `openWorktree` reached after a *successful* `git worktree add`,
 * and that is why the fault ends by naming what is left behind. Nothing catches here and nothing
 * calls `undoOwnBranch` — deliberately, because the module's non-destructive rule is at its
 * strongest on a path where somebody has planted a link, and the registration is git's to clear
 * anyway — so two things of awcli's survive: the branch, whose `git branch` exited zero, and git's
 * registration of the working copy, whose add exited zero. Both are certain rather than possible,
 * which is what lets the sentence state them.
 *
 * "Nothing was removed" was the whole of it, which is accurate about the *target* and silent about
 * those two, and the silence costs the operator four steps: the next invocation of this run and slot
 * is refused `occupied` over the planted link; `worktreeRegistration` answers `unregistered`,
 * because the registration's canonical path is the link's destination while `canonicalPath(target)`
 * leaves the last component unresolved, so they are told git has nothing registered there; they
 * delete the link and run again; and they are refused `branch-exists` and handed
 * `git branch -d awcli/<run>/<slot>`, which fails naming a working copy at a path they have never
 * seen. Every other leftover path in this module names what may survive — the cut's catch says a
 * branch "may exist even though the working copy does not" — and this one is the path where the
 * answer is not "may". Watched by workspace-faults.test.ts's "inside the repository but outside the
 * runtime directory" case, which asks `git branch --list` and `git worktree list --porcelain` what
 * is actually there rather than only matching the prose, and by the gate mutation that empties the
 * clause.
 *
 * The fault goes through `printable`, and `placed` is the reason rather than the paths awcli derived
 * itself. This guard fires precisely when someone planted a symlink in the layout, so the resolved
 * destination it quotes is a filename the attacker chose — and a filename may hold any byte but NUL
 * and `/`. An ESC repaints the terminal over the fault; a U+202E reverses the rendering of the rest
 * of the sentence. This is the message in this module whose content is *guaranteed* adversarial,
 * which is the load-bearing half of what this sentence used to say. The other half — that it was the
 * last one still interpolating raw — is true of nothing now, and was not true when it was written:
 * grepping the file for an interpolated `dir`, `cwd`, `repositoryPath` or resolved path that reaches
 * a message through neither `printable` nor `shellPath` finds none, `describe`'s two sentences
 * included. That grep is scoped to this file, which is what made it insufficient rather than wrong:
 * `git-process.ts` writes three of its own messages about a failed invocation, and interpolated the
 * `cwd` this module hands it raw in all three while sanitising the binary, the argv and the signal
 * beside it. Sanitising by delegation is not sanitising, so that file now carries its own bound. The one value still interpolated raw is `branch`, in the remedies, and that is a value
 * awcli *constructed* — `workspaceBranch(runName, slot)` over a run name the gate chain validated
 * and a slot this module refuses unless it is already lowercase — rather than one it found on disk.
 * `target` and the expected path are bounded for the lesser reason: neither can flood a terminal that
 * has one fault to show.
 */
async function assertInsideRuntimeDirectory(
  repositoryPath: string,
  target: string,
  branch: string,
): Promise<void> {
  const root = await realpath(repositoryPath).catch(() => undefined);
  const expected =
    root === undefined ? undefined : join(root, relative(repositoryPath, target));
  const placed = await realpath(target).catch(() => undefined);
  if (expected === undefined || placed === undefined || placed !== expected) {
    // Both leftovers are certain rather than possible, which is why they are stated and not hedged:
    // the `git branch` above exited zero, which it does only when it created the ref, and the
    // `git worktree add` above exited zero, so git registered the working copy. See the docblock.
    const leftovers = `Two things of awcli's are behind that and neither has been put back: the branch ${branch}, which awcli cut for this working copy, and git's registration of the working copy itself — which names the path the link resolves to and not this one, so a later run asking "git worktree list" about this path is told git has nothing here. "git worktree list" says what git holds and where it points, and "git branch --list ${branch}" says the branch is there.`;
    throw new Error(
      `awcli made a working copy for this run at ${printable(target, PATH_LIMIT)}, and that is not where it is: it is at ${placed === undefined ? "a path awcli could not resolve" : printable(placed, PATH_LIMIT)}, where awcli expected ${expected === undefined ? "a path it could not resolve" : printable(expected, PATH_LIMIT)}. Something between the repository root and that leaf is a link, so an agent would be working somewhere other than the directory everything awcli reports names — outside ${printable(worktreesRoot(repositoryPath), PATH_LIMIT)} altogether, or in another run's. Nothing was removed — look at what is at that path before running again. ${leftovers}`,
    );
  }
}

/**
 * Whether git has a working copy registered at a path, and whether that registration is locked.
 *
 * The question the `occupied` refusal turns on, because the answers have different remedies and two
 * of them are commands git rejects. `git worktree remove` on an ordinary directory exits 128 with
 * `fatal: ... is not a working tree`. On a *locked* registration it exits 128 with `fatal: cannot
 * remove a locked working tree, lock reason: <reason> / use 'remove -f -f' to override or unlock
 * first` — and `--force` exits 128 identically, because git wants the second `-f` for that one.
 * `git worktree prune` does not help either: it left a locked registration listed even with the
 * directory deleted. All measured on git 2.55 on the machine this was written on. The first version
 * of that message advised the removal unconditionally, on a branch whose own comment says it fires
 * for *anything at all*, and the test only string-matched the sentence — so the suite was green over
 * advice that does not run.
 *
 * The lock is read because it answers a question this module had been getting wrong from the other
 * side, and getting wrong in the one direction that costs somebody their work. `git worktree add`
 * registers the working copy at the *start* of its run, not at the end: from the first moment of the
 * add the entry is listed with its `HEAD` and its `branch` and carries the attribute
 * `locked initializing`, and the attribute goes only once the add exits zero. Verified on git 2.55
 * by polling `git worktree list --porcelain` through an add held open with a `filter.<driver>.smudge`
 * that sleeps. A losing racer — which reaches the `found` site whenever the winner's `mkdir` lands
 * before its own `lstat`, the ordering `Occupancy` records CI producing on the first try — therefore
 * asks this question in the middle of the winner's checkout and gets a registration back. Answering
 * `registered` for that sent the loser the one arm with no racing hedge on it: remove the winner's
 * in-flight working copy, delete the branch its agent is committing onto. `initializing` is that
 * state told apart from a settled one, and it is git's own word for it rather than awcli's guess.
 *
 * It is not proof against an operator who wrote that word themselves — `git worktree lock --reason
 * initializing` is indistinguishable from git's own lock, and nothing in the output separates the
 * two. What that costs is the safe direction: such an operator is told to wait for a run that has
 * already finished, rather than being told to remove something a live run is using. Recorded here
 * rather than defended against, because the defence would have to be a guess about which of two
 * identical answers git meant.
 *
 * `unknown` is a separate answer rather than a default to one of the others, and it is why this asks
 * git through the raw runner instead of through `run`: this builds a *refusal message*, so it must
 * not throw, and a git that cannot answer must not be turned into a confident sentence in any
 * direction.
 *
 * Paths are compared with the parent resolved and the last component left alone. That divergence is
 * the reason it was written — `git worktree list` prints canonical paths, on macOS `/private/var/...`
 * where awcli held `/var/...`, so a string comparison answered `unregistered` for every worktree in a
 * temp directory — and the reason has since gone: the layout is built from `rev-parse
 * --show-toplevel`, which is git's own physical path, so the two spellings already agree on every
 * reachable path. It is kept as belt and braces rather than deleted, because the cost is one `lstat`
 * on a refusal path and the failure it would restore is silent (a registered working copy reported
 * `unregistered`, with the remedy that leaves the registration holding the branch). Nothing watches
 * it, and no gate mutation can: with `--show-toplevel` in place both implementations agree.
 */
type WorktreeRegistration =
  | { readonly answer: "registered" | "initializing" | "unregistered" | "unknown" }
  /** The reason git recorded, which is a string somebody chose. Sanitised where it is printed. */
  | { readonly answer: "locked"; readonly reason: string };

/**
 * The registration answers on their own, for the machine-readable half of a refusal.
 *
 * The reason does not travel with them: it is prose for the operator to recognise a lock by, and a
 * consumer branching on it would be branching on a string an agent can write. See
 * `WorkspaceRefusalDetail`.
 */
export type WorktreeRegistrationAnswer = WorktreeRegistration["answer"];

/**
 * The lock reason `git worktree add` holds a working copy under while it is checking it out.
 *
 * git's own word, read back out of git's own output — awcli never writes a lock. Spelled once
 * because the message that explains the state to an operator quotes it verbatim, and a sentence
 * naming an attribute the code no longer recognises is worse than no sentence.
 */
const INITIALIZING_LOCK = "initializing";

/** The attribute record `git worktree list --porcelain` prints for a locked registration. */
const LOCKED_ATTRIBUTE = "locked";

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
  // `-z` rather than the newline form, because git prints paths raw in `--porcelain`: no quoting and
  // no escaping. A filename may hold a newline, so a working copy registered at
  // `<repo>/spoof\nworktree <target>\nx` emits lines that parse as records of their own, and awcli
  // answered "registered" for a target nothing was registered at — reproduced on git 2.55. Both
  // consumers then lead with `git worktree remove '<target>'`, which exits 128 on an unregistered
  // path: the exact defect the docblock above says this function exists to prevent, reachable by any
  // agent that can run git in the shared dir. Under `-z` one record is one attribute, so an embedded
  // newline stays inside the path it belongs to. The same holds of a lock *reason*, which git prints
  // raw under `-z` and quotes under the newline form — verified both ways on git 2.55, with a reason
  // containing a newline printing as `locked "line one\nline two"` in one and as one NUL-terminated
  // record in the other. A git too old for the switch exits non-zero and lands on `unknown`, which
  // names every remedy and claims none.
  //
  // Which is the safe direction and is not the same as costing nothing, and that is why `-z` is now
  // what sets awcli's documented floor. Below 2.36 this function can only ever answer `unknown`, so
  // the `registered`, `initializing`, `locked` and `unregistered` arms are all unreachable and every
  // operator on such a git gets the hedged sentence — worse than the pre-`-z` behaviour on those
  // versions, which answered correctly and unsafely. The alternative was to retry without `-z` and
  // treat any record containing a newline as `unknown`, which keeps 2.22-2.35 working; it was
  // declined because it is a second parser for a git version nobody here can run, in the one
  // function whose whole job is to avoid being confidently wrong. So the README says 2.36, which is
  // four years old, and this stays one parser. Nothing hard-fails below it — the answer is `unknown`
  // and the refusals still name every remedy — so the floor is a statement about which refusals an
  // operator gets, not about whether awcli starts.
  const listed = await git(
    ["worktree", "list", "--porcelain", "-z"],
    repositoryPath,
  ).catch(() => undefined);
  if (listed === undefined || listed.kind !== "ran" || listed.code !== 0)
    return { answer: "unknown" };
  const wanted = await canonicalPath(target);
  // One *entry* at a time, rather than one record at a time, because the discriminator this now
  // reads is an attribute of an entry and an attribute cannot be recognised on its own: `locked`
  // says nothing about which working copy it belongs to. git's format is a `worktree <path>` record
  // opening an entry, its attributes as records of their own after it, and an empty record closing
  // it — which under `-z` is a NUL after every record and therefore two NULs between entries.
  // Confirmed against `od -c` on git 2.55. So the path record decides whether this is the entry
  // being asked about, the attributes are read only while it is, and the answer is given when the
  // entry closes rather than when it opens.
  const prefix = "worktree ";
  let mine = false;
  let lock: string | undefined;
  const answer = (): WorktreeRegistration =>
    lock === undefined
      ? { answer: "registered" }
      : lock === INITIALIZING_LOCK
        ? { answer: "initializing" }
        : { answer: "locked", reason: lock };
  for (const record of listed.stdout.split("\0")) {
    if (record.startsWith(prefix)) {
      // A new entry opens, so whatever the last one said about a lock stops applying — and that one
      // assignment is the whole of the entry scoping. `locked` is an attribute of an entry and the
      // record carries nothing saying which working copy it belongs to, so a reader that let it
      // carry over would attribute an operator's own deliberately locked worktree to the target and
      // then tell them to unlock and remove a path git has nothing registered at, which exits 128.
      // A second `if (this is not the entry asked about) continue` guard over the attributes would
      // enforce the same invariant and nothing could tell the two mechanisms apart, so there is one.
      //
      // No `trim` on the path: `-z` delimits exactly, and a path may legitimately end in a space.
      mine = (await canonicalPath(record.slice(prefix.length))) === wanted;
      lock = undefined;
      continue;
    }
    // The empty record closes the entry, and that is where the answer is given: at the `worktree`
    // record above, the attributes it turns on have not been read yet.
    if (record.length === 0) {
      if (mine) return answer();
      continue;
    }
    // A lock with no reason prints as the bare attribute, one with a reason as `locked <reason>`.
    // Both measured on git 2.55; the empty reason is carried as an empty string rather than folded
    // into "unlocked", because a lock somebody set without saying why is still a lock git refuses
    // the removal for.
    if (record === LOCKED_ATTRIBUTE) lock = "";
    else if (record.startsWith(`${LOCKED_ATTRIBUTE} `))
      lock = record.slice(LOCKED_ATTRIBUTE.length + 1);
  }
  // The last entry is closed by the trailing NUL pair above, so this is reached only for output that
  // ends without one — nothing git 2.55 produces, and `unregistered` is the answer that claims least
  // about a shape awcli did not recognise.
  return mine ? answer() : { answer: "unregistered" };
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
 * How awcli found out the target was taken, which decides how much the message may claim.
 *
 * `found` is the `lstat` at the top of `openWorktree`: awcli looked, and something was there before
 * it touched anything. `raced` is EEXIST from awcli's own `mkdir` — the path was free when it looked
 * and taken by the time it created, which is direct evidence of another writer working right now.
 *
 * The distinction is worth making and is *not* what makes the settled sentences safe, which is what a
 * first attempt at this assumed. A losing racer reaches either site depending on scheduling: if the
 * winner's `mkdir` lands before the loser's `lstat`, the loser discovers a `found` target and never
 * sees EEXIST at all. That is not a rare ordering — it is the one a CI runner produced on the first
 * try, where this machine had produced the other eight times out of eight. So the arms a `found`
 * discovery reaches had to stop claiming a settled world too; `raced` is the stronger sentence awcli
 * can give when it happens to have the stronger evidence, not the fix.
 *
 * What makes those arms safe is `worktreeRegistration`, and only since it learned to read the lock.
 * A loser landing on `found` is asking git about the target in the middle of the winner's
 * `git worktree add`, and git registers the working copy from the *start* of that add and marks it
 * `locked initializing` for the whole of it — so `initializing` is the answer a loser most often
 * gets, and it is a positive, unambiguous "a run is provisioning here right now" rather than an
 * absence to be hedged around. The narrow gap left is the winner's own `mkdir` and cut, before its
 * add has begun: for those few milliseconds the directory exists and nothing is registered, which is
 * what keeps the `unregistered` arm hedged at all.
 */
type Occupancy = "found" | "raced";

/**
 * Whether awcli has itself created the target directory by the time a branch refusal is worded.
 *
 * The `Occupancy` question one refusal over. `collisionMessage` looks at the target again before it
 * advises anything that would touch what is there, and what that second look means depends on who
 * put it there: at the early site awcli has never created the directory, so anything at it is another
 * writer's. At the late site awcli made it and gave it back with a best-effort `rmdir`, so what is
 * there may be awcli's own leftover — the `rmdir` failing is the whole of the difference, and nothing
 * in the second look can tell that from another writer. (Not "a directory git wrote into before
 * failing", which is what this said: the late site is reached from a non-zero exit of the *cut*, so
 * `git worktree add` has not run and nothing of git's is in there.) `created-and-removed` is what
 * stops the confident racing-writer sentence being given about awcli's own abandoned directory, and
 * it is why this is a parameter rather than something the function could work out for itself. Watched
 * by the fs-fault suite, which stages a cut that fails over a leftover, and by the gate mutation that
 * collapses the two answers into one.
 */
type TargetClaim = "untouched" | "created-and-removed";

/**
 * What to say about a target that is not free, the remedy that fits what is actually there, and the
 * discriminator a consumer reads instead of the sentence.
 *
 * Five answers for a target awcli *found* taken, because git distinguishes five states and the
 * remedies genuinely differ. An *unlocked* registration is cleared with `git worktree remove`, which
 * also clears the registration that would otherwise go on holding this run's branch — and which
 * refuses while there is uncommitted work in it, which is the answer an operator wants. A
 * registration locked with the reason `initializing` is a `git worktree add` that has not finished:
 * nothing is to be removed, because the thing at that path is another acquisition's live working
 * copy, and every command the removal arm names exits non-zero in that state anyway. A registration
 * locked for some other reason is somebody's deliberate hold, and the removal only runs after
 * `git worktree unlock`. Anything with no registration at all is an ordinary directory as far as git
 * is concerned and `git worktree remove` refuses it, so the remedy is to move it or delete it. And
 * when git could not be asked, the sentence names them and claims none.
 *
 * A sixth for a target awcli *raced* for, and that one is not a state of the path but of awcli's
 * knowledge: EEXIST from its own `mkdir` is stronger evidence of a live writer than any answer git
 * could give about a world that is still changing, so it is answered without asking.
 *
 * What this section used to argue, and what made the `registered` arm dangerous, was that
 * `worktreeRegistration`'s answers were "all about a settled world" and that a target another writer
 * was halfway through claiming was a state it had no answer for. That is false, and it is false in
 * git's favour: `git worktree add` registers the working copy at the *start* of the add and marks the
 * entry `locked initializing` until the checkout finishes (verified on git 2.55; see
 * `worktreeRegistration`). So `git worktree list` is precisely the command that says whether a run is
 * provisioning at a path, and the answer a losing racer most often gets is a positive one. The
 * sentences point the operator at it rather than away from it, which is the opposite of what they did.
 */
async function occupiedRefusal(
  git: GitRunner,
  repositoryPath: string,
  target: string,
  runName: RunName,
  branch: string,
  occupancy: Occupancy,
): Promise<{
  readonly message: string;
  readonly detail: WorkspaceRefusalDetail;
}> {
  if (occupancy === "raced") {
    return {
      message: `awcli will not provision a working copy at ${printable(target, PATH_LIMIT)} for the "${runName}" run: that path was free when awcli looked and occupied by the time it created it. Something arrived in that window, and another acquisition of this run and slot is the likeliest thing it was — but a file, a directory or a symlink somebody else put there comes back as the same EEXIST, so awcli will not tell you a run is there when what it has is an errno. Look at what is there before doing anything to it, and wait for that run if a run is what it turns out to be — "git worktree list" is what says whether a run is still provisioning there, because git registers a working copy from the moment "git worktree add" starts and marks the entry "locked initializing" until its checkout finishes. Or run this under a different --name.${unshowablePathNote(target)}`,
      detail: { kind: "occupied", occupancy, registration: undefined },
    };
  }
  const registration = await worktreeRegistration(git, repositoryPath, target);
  const remedy =
    registration.answer === "registered"
      ? `Otherwise that is a working copy git still has registered, so clear it with "git worktree remove ${shellPath(target)}" rather than by deleting the directory — a registration left behind goes on holding this run's branch — and then "git branch -d ${branch}", which is not the optional half if you mean to run this run and slot again: the branch is a pure function of both, so leaving it behind turns this refusal into the branch-exists one on the next attempt. The removal refuses while there is uncommitted work in there, and the delete refuses while the branch holds work no other branch has — both of which are the answer you want; git prints its own "-D" form to insist with.`
      : registration.answer === "initializing"
        ? `Otherwise git has that path registered and marked "locked ${INITIALIZING_LOCK}", which is what a "git worktree add" that has not finished looks like: another acquisition of this run and slot is checking a working copy out there right now. Wait for it and remove nothing — the run that is using that path and this run's branch has not finished with either, and git would refuse anyway: "git worktree remove" exits 128 on a locked working copy, "--force" included, and the branch delete exits 1 while a working copy holds the ref. "git worktree list" is where to watch for the lock going.`
        : registration.answer === "locked"
          ? `Otherwise git has that path registered and locked, ${registration.reason.length === 0 ? "with no reason recorded" : `for the recorded reason "${printable(registration.reason)}"`} — so somebody held it deliberately and "git worktree remove" refuses it while the lock stands, "--force" included, and "git worktree prune" will not clear it either. Look at what that lock is for first; then "git worktree unlock ${shellPath(target)}" and "git worktree remove ${shellPath(target)}" clear it, and "git branch -d ${branch}" the branch, which running this run and slot again needs done rather than left — which refuses while the branch holds work no other branch has, and git prints its own "-D" form to insist with.`
          : registration.answer === "unregistered"
            ? `Otherwise git had nothing registered there when awcli asked, which is nearly an answer and not quite one: git registers a working copy from the moment "git worktree add" starts and marks it "locked ${INITIALIZING_LOCK}" for the whole checkout, so a run already checking out there would have shown up — but one that has made the directory and not yet reached its add would not, and that gap is milliseconds wide. So ask "git worktree list" once more, and look at what is actually in there, before you move or delete it. "git worktree remove" is not the command for an ordinary directory and git refuses it for one.`
            : `Otherwise clear it before running again — "git worktree list" says whether git has a working copy registered there, "git worktree remove ${shellPath(target)}" clears one that is not locked, and an ordinary move or delete is the answer if git has nothing there. awcli could not ask git which of those this is.`;
  return {
    message: `awcli will not provision a working copy at ${printable(target, PATH_LIMIT)} for the "${runName}" run: something is there already, and awcli never removes or writes over what it finds. If a run is in progress, wait for it. ${remedy} Or run this under a different --name.${unshowablePathNote(target)}`,
    detail: { kind: "occupied", occupancy, registration: registration.answer },
  };
}

/**
 * A ref that stops `awcli/<run>/<slot>` being created, and how.
 *
 * Four shapes rather than one, because the remedy differs and only the first is awcli's own doing.
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
  /**
   * `same`: this branch. `namespace`: `awcli` itself, which blocks every run. `prefix`: `awcli/<run>`,
   * which blocks only this one. `below`: a branch under this one.
   *
   * `namespace` is split out of `prefix` because the remedy differs and the message was offering one
   * that cannot work. Both sentences ended "or run this under a different --name", and for
   * `refs/heads/awcli` that is dead advice: the ref blocks every branch under `awcli/` whatever the
   * run is called. Verified on git 2.55 — with `awcli` present, `worktree add -b awcli/other/main`
   * fails exactly as `awcli/triage/main` did, and succeeds once the branch is renamed to
   * `awcli/triage`. The test that covered this asserted the message contained "--name", so the suite
   * was green over the half of the advice that does not run.
   */
  readonly kind: "same" | "namespace" | "prefix" | "below";
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
  | { readonly ok: false; readonly why: string; readonly cause?: unknown }
> {
  // Total, which is the fix: this used to return a failure only for a non-zero *exit*, and the runner
  // does not confine itself to those. It rejects for a git that has gone missing, for a `cwd` that
  // has, for the 120s timeout, and for an answer past `GIT_MAX_BUFFER` — and the last one is
  // reachable precisely because this query has no pattern. Measured on git 2.55: 20,001 packed refs
  // named `refs/heads/topic/branch-number-<n>` answer in 728,906 bytes and 81-98ms, so at 36 bytes a
  // ref the 16MB bound arrives at around 460,000 branches. That is not an exposure, and prior runs
  // recorded it as one; what it is, is a repository where the operator got the runner's sentence
  // about bytes instead of the "awcli could not list the branches" fault written one line below the
  // early call site. The reason it carries prose rather than an exit code is that half of what can
  // go wrong here has no exit code to carry.
  const listed = await run(
    git,
    ["for-each-ref", "--format=%(refname)", "refs/heads"],
    repositoryPath,
  ).catch((error: unknown) => ({ threw: error }) as const);
  if ("threw" in listed) {
    return {
      ok: false,
      why: listed.threw instanceof Error ? listed.threw.message : String(listed.threw),
      cause: listed.threw,
    };
  }
  if (listed.code !== 0) {
    return {
      ok: false,
      why: `git for-each-ref exited ${listed.code}. ${gitComplaint(listed.stderr)}`,
    };
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
 * Puts back the two things awcli made for a working copy that then failed to appear.
 *
 * Only ever called after `git branch` has exited zero, which is the whole of the ownership proof: git
 * refuses a name that exists, so a zero exit means this call created the ref and nothing else did.
 * That is why the branch is cut in its own invocation — see the note at the call site for what
 * inspecting the ref afterwards could and could not establish.
 *
 * Deleting a branch awcli cut inside the same failed call is not the destructive behaviour the module
 * docblock forswears; leaving it is. It has no commits on it — it points at the sha the preflight
 * read, moments ago — and left behind it makes the run and slot unusable for good. BR-036's
 * Exceptions carry that carve-out, and the rule is where it belongs: it was written onto AWCLI-13's
 * Constraints and into this comment first, which left the rule a reader consults saying awcli never
 * deletes a branch automatically while this line does, with the reconciliation on a ticket that will
 * be closed. A behaviour outside an approved rule that only the code records is the drift the
 * amendment log exists for, and so is one recorded next to the code instead of in the rule.
 *
 * Best effort, through the raw runner with a `catch`, like `worktreeRegistration`: the outcome here is
 * already a failure, and a rejection from the tidying would replace the fault that names git's own
 * complaint with a complaint about the tidying.
 *
 * What it *managed* comes back, and that is the correction rather than a convenience. Both outcomes
 * used to be discarded — the `rmdir` behind a swallowing `catch` and the delete's exit status not
 * looked at — so the fault the caller then threw said nothing about either and read as though awcli
 * had put everything back. Neither call succeeds in the state that matters. SIGKILL of
 * `git worktree add` mid-checkout — the OOM killer's own signal, where git's cleanup handler does not
 * run — leaves a part-checked-out target, so `rmdir` exits ENOTEMPTY, and leaves the registration
 * holding the branch, so `git branch -D` exits 1 with `cannot delete branch '<name>' used by worktree
 * at '<path>'`. Both measured on git 2.55, the second with the registration locked, which git counts
 * as holding the ref exactly as an ordinary one does.
 *
 * The pair of statuses is also what lets the caller claim something rather than hedge everything: a
 * `git branch -D` that *succeeded* is proof that no working copy held the ref, since that is the one
 * reason git refuses one — so with the directory gone too, there is nothing of awcli's left and the
 * fault says nothing about leftovers. See `undoneResidual`.
 */
type Undone = {
  /**
   * Whether the directory awcli made is gone. `rmdir` is what holds that to "empty": it refuses a
   * directory with anything in it, so `left-behind` means something is in there — git's partial
   * checkout, in the case this is written for.
   *
   * ENOENT counts as `removed`, which is the correction: the directory being *already* gone is the
   * outcome this axis reports, not a failure to reach it. It is the ordinary state on the
   * `no-such-directory` shape — the repository directory has been removed, and the target lives
   * under it — and there `left-behind` made the residual say "there is something in <target>" about
   * a path that no longer exists at all.
   */
  readonly directory: "removed" | "left-behind";
  /**
   * What `git branch -D` said about the ref the cut created. Three answers rather than two, because
   * the residual makes a claim that only one of them supports.
   *
   * `deleted` is a zero exit. `left-behind` is a git that *ran* and refused, which is the only state
   * in which "a working copy is still holding the ref" is a deduction rather than a guess — that
   * being the one reason git refuses this delete. `no-answer` is everything else: git could not be
   * started, its `cwd` had gone, or the runner gave up on it (the 120s timeout, an answer past the
   * read bound, a child killed by a signal). In none of those did git say anything about the ref, so
   * awcli knows neither whether it is there nor whether a command it might name would run.
   *
   * Collapsing `no-answer` into `left-behind` is how the wrong version of this shipped: on the two
   * shapes where git never ran at all, the residual told the operator the branch had survived
   * *because git refused the delete*, and then handed them four git commands to run in a repository
   * the same fault had just said git could not be reached in.
   */
  readonly branch: "deleted" | "left-behind" | "no-answer";
};

async function undoOwnBranch(
  git: GitRunner,
  repositoryPath: string,
  branch: string,
  target: string,
): Promise<Undone> {
  const directory = await rmdir(target).then(
    () => "removed" as const,
    // ENOENT is not a leftover. `rmdir` rejects both for a directory with something in it and for one
    // that is not there, and only the first is something for the operator to clear — so folding them
    // together made the residual describe contents of a path that had gone, which is the ordinary
    // case when the repository directory itself is what vanished under the run.
    (error: unknown) =>
      isErrno(error, "ENOENT") ? ("removed" as const) : ("left-behind" as const),
  );
  // `NO_HOOKS` here too: this is a ref update like the cut it undoes, so it runs
  // `reference-transaction` out of the shared git dir without it — and it runs on the *failure* path,
  // where an operator is already being handed a fault and is least able to account for a hook that
  // fired. `-D` and not `-d` is deliberate and is the one place in this file where it is: the branch
  // is provably awcli's own (`git branch` exited zero, which it does only when it created the ref) and
  // provably commitless (it points at the sha the preflight read moments ago), so there is nothing for
  // `-d` to protect and its merged-ness check would leave the leak behind on a repository whose HEAD
  // has moved. Every *operator-facing* remedy names `-d`; see `collisionMessage`.
  const deleted = await git([...NO_HOOKS, "branch", "-D", branch], repositoryPath).catch(
    () => undefined,
  );
  // The raw runner is used here rather than `run`, so the two no-git outcomes arrive as *values* and
  // can be told from a refusal instead of being flattened into one. That distinction is the whole of
  // why `no-answer` exists: `left-behind` is a claim about what git said, and git that did not run
  // said nothing. See `Undone.branch`.
  return {
    directory,
    branch:
      deleted === undefined || deleted.kind !== "ran"
        ? "no-answer"
        : deleted.code === 0
          ? "deleted"
          : "left-behind",
  };
}

/**
 * What awcli did not manage to put back, and the commands that clear what is left.
 *
 * Nothing at all when both went back, which is a claim the pair of statuses supports rather than a
 * hopeful default: git refuses `git branch -D` for a branch a working copy holds, so a delete that
 * exited zero says no registration held this run's ref, and with the directory gone as well there is
 * nothing of awcli's for the operator to find. Saying nothing is then the right answer — a fault
 * that lists three hypothetical leftovers on the ordinary failing-add path buries git's own
 * complaint, which is the sentence the operator actually needs.
 *
 * And a third answer that is neither: `no-answer` says git never told awcli anything about the ref,
 * so the arm for it claims nothing about why the branch survived and conditions every command on a
 * git that can be run again. The two confident arms are deductions from what git *said* — a refusal
 * means a working copy holds the ref — and applying either to a git that never ran produced a fault
 * asserting three false things and naming four commands that could not be typed.
 *
 * When something *is* left, the commands named are the ones that work in that state, and they are
 * not the set every other remedy in this module names. A registration `git worktree add` abandoned is
 * locked with the reason `initializing`, and on a locked registration `git worktree remove` exits 128
 * and so does `--force` — git asks for `-f -f` — while `git worktree prune` leaves the entry listed
 * even once its directory has gone. So `unlock` then `remove`, or `remove -f -f`, is the pair that
 * clears it, and the branch delete only works after that. All measured on git 2.55. Shared by the
 * add's two failure exits because the residual and the next step are the same on both.
 *
 * `-d` for the branch, as everywhere else operator-facing: awcli's own `-D` is justified where it is
 * used by a proof the operator does not have. And every path goes through `printable`/`shellPath`,
 * because the target is a path and a message is a terminal.
 */
function undoneResidual(undone: Undone, branch: string, target: string): string {
  if (undone.directory === "removed" && undone.branch === "deleted") return "";
  const where = printable(target, PATH_LIMIT);
  const left =
    undone.branch === "no-answer"
      ? // Neither of the two confident sentences below, because both are claims about what git said
        // and git said nothing. What awcli knows here is what it *asked*, so that is what it reports:
        // it cut a branch, it could not get an answer about deleting it, and the ref's fate is
        // therefore the operator's to establish rather than awcli's to assert.
        undone.directory === "removed"
        ? `awcli removed the directory it had made, but got no answer from git about deleting ${branch}: whatever stopped the add stopped that delete too, so awcli cannot say whether that branch is still there.`
        : `awcli could not account for either of the two things it made: there is something in ${where}, and it got no answer from git about deleting ${branch} — whatever stopped the add stopped that delete too, so it cannot say whether that branch is still there.`
      : undone.directory === "removed"
        ? `awcli removed the directory it had made, but "git branch -D ${branch}" did not succeed, so that branch is still there.`
        : undone.branch === "deleted"
          ? `awcli deleted the branch it had cut, but could not remove ${where}: there is something in it now, and awcli removes only a directory that is still empty.`
          : `awcli could not put back either of the two things it made: there is something in ${where}, and ${branch} is still there — which is what git refusing that delete means, because the one reason it refuses is a working copy still holding the ref.`;
  // The commands are the same set on all three, and on `no-answer` they are the same set *later*:
  // every one of them is a git invocation, and the state that produced `no-answer` is a git that
  // could not be run — in the `no-such-directory` shape, in a repository that is no longer there. So
  // they are conditioned rather than dropped. Naming them flatly was the second half of the defect
  // the third arm carried: advice that cannot be followed until the fault the operator is reading
  // about has been dealt with, presented as the next thing to type.
  const once =
    undone.branch === "no-answer" ? "Once git can be run in that repository again, " : "";
  return `${left} ${once}"git worktree list" says whether git also still has a working copy registered at that path. If it has, the entry will be locked with the reason "${INITIALIZING_LOCK}", and a locked one refuses "git worktree remove" and "--force" alike and survives "git worktree prune" even with its directory gone — so "git worktree unlock ${shellPath(target)}" and then "git worktree remove ${shellPath(target)}" is what clears it, or "git worktree remove -f -f ${shellPath(target)}" in one step. Then "git branch -d ${branch}" for the branch, which git refuses while a working copy still holds it.${unshowablePathNote(target)}`;
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
  // `COMMAND_PATH_LIMIT`, not `printable`'s own default: this value is handed to the operator with
  // "rename or delete it" after it, so truncating it produces a name that does not exist. See the
  // constant, which carries the arithmetic that makes it reachable.
  const short = (ref: string): string =>
    printable(ref.slice("refs/heads/".length), COMMAND_PATH_LIMIT);
  const matching = (candidate: string): string | undefined => {
    const wanted = `refs/heads/${candidate}`.toLowerCase();
    return existing.find((ref) => ref.toLowerCase() === wanted);
  };

  const same = matching(branch);
  if (same !== undefined) return { kind: "same", ref: short(same) };
  for (const candidate of workspaceBranchPrefixes(runName)) {
    const prefix = matching(candidate);
    // Which of the two prefixes matched decides whether a different `--name` is a remedy at all: the
    // first is `BRANCH_NAMESPACE` and blocks every run, the second is `awcli/<run>` and blocks this
    // one. Read off the candidate rather than off the ref, because the ref comes back in the
    // operator's own spelling and may differ in case.
    if (prefix !== undefined) {
      return {
        kind: candidate === BRANCH_NAMESPACE ? "namespace" : "prefix",
        ref: short(prefix),
      };
    }
  }
  const beneath = `refs/heads/${branch}/`.toLowerCase();
  const below = existing.find((ref) => ref.toLowerCase().startsWith(beneath));
  if (below !== undefined) return { kind: "below", ref: short(below) };
  return undefined;
}

/**
 * What to say about a branch that is in the way, and what to do about it.
 *
 * The `same` remedy names `git worktree remove` as well as the branch delete, and that is the finding
 * this function exists for rather than a flourish: release is a no-op and collection is AWCLI-22's,
 * so the operator's only cleanup today is by hand — and deleting the working copy's *directory*
 * leaves git's registration for it, which goes on holding the branch. A branch delete then fails with
 * "cannot delete branch ... used by worktree at <a path that is not there any more>", and the run
 * name is unusable until they find `git worktree prune`. Reproduced on git 2.55 before this was
 * written; `git worktree remove` clears the registration even when the directory has already gone.
 *
 * Every delete it names is `git branch -d`. `-D` is what this said, and it is a command that destroys
 * the thing the same sentence calls the deliverable: release is inert and collection is AWCLI-22's, so
 * this refusal is the only cleanup path a run has today, and the operator reading it has not been told
 * whether anything is on that branch. `-d` refuses an unmerged one and prints git's own `-D` hint, so
 * insisting costs one paste and not insisting costs nothing. Reproduced both ways on git 2.55.
 * `undoOwnBranch` still uses `-D`, and says there why that one is not this.
 *
 * And every sentence naming it says that it refuses, which is the half the swap from `-D` first left
 * behind: the arms asserted flatly that the command "deletes it", and the state this whole refusal
 * exists for — BR-036, a finished run of this name and slot whose branch carries the agent's commits
 * — is exactly the state where `git branch -d` exits 1 with "not fully merged". So the confident
 * wording was false for every run that committed anything, and the only refusal it accounted for was
 * a working copy holding the branch, which `git worktree list` answers and this one is not. git prints
 * the `-D` form itself, so the sentence only has to say that insisting is what that hint is for.
 */
async function collisionMessage(
  git: GitRunner,
  repositoryPath: string,
  collision: BranchCollision,
  branch: string,
  runName: RunName,
  target: string,
  claim: TargetClaim,
): Promise<string> {
  if (collision.kind === "same") {
    // Before any remedy that touches what is at the target: is another acquisition of this run and
    // slot provisioning onto this very branch right now? `occupiedRefusal` asks that question and this
    // did not. The window is not new and cutting the branch in its own call did not widen it much:
    // `-b` published the ref before it validated the target (verified, and recorded at the cut
    // below), so under the combined form too the winner's branch was visible for the whole of its
    // checkout. What the split adds is the gap between two processes at the front of it. Either way
    // a loser's collision query routinely finds a branch a live run cut a moment ago, and every
    // remedy below would have told it to remove the winner's working copy and delete the winner's
    // branch — which is a consequence of a loser reaching this site at all, not of the split.
    //
    // The evidence is awcli's own `lstat`, asked again. Reaching this site at all means nothing was at
    // the target when awcli looked; a winner whose branch exists has already created that directory,
    // because `mkdir` precedes the cut. So something being there *now* is another writer working right
    // now — the same class of evidence EEXIST from `mkdir` is on the occupied path, and unlike the
    // *settled* answers below it is not about a settled world. Not "the three answers below": there
    // are five, and `initializing` is itself an unsettled one, which is the whole correction
    // `occupiedRefusal` records at the top of its own arm list — the sentence that called git's
    // answer settled was "false, and false in git's favour", and it is what made the registered arm
    // dangerous. A maintainer who followed this copy would drop the hedging that stops a losing
    // racer being told to clear a live winner's worktree. Only where awcli has not itself claimed
    // and released the path (`TargetClaim`), or its own leftover would be read as a racing writer.
    //
    // Guarded, for `worktreeRegistration`'s reason: this builds a *refusal*, so it must not throw.
    // `lstatOrMissing` rethrows anything that is not ENOENT — a parent that has gone, a directory
    // that stopped being readable — and an escape from here would replace the refusal and its
    // remedies with a raw errno. Falling back to the three settled answers is the pre-existing
    // behaviour, which is the safe direction for a question this one only ever *adds* caution to.
    // "The settled answers" again, and for the same reason: `initializing` is not one of them.
    const arrived =
      claim === "untouched"
        ? await lstatOrMissing(target).catch(() => undefined)
        : undefined;
    if (arrived !== undefined) {
      return `awcli will not cut the branch ${branch} for the "${runName}" run: it already exists, and ${printable(target, PATH_LIMIT)} was free when awcli looked a moment ago while something is there now — so another acquisition of this run and slot is almost certainly provisioning onto that branch right now. Wait for that run: do not remove what is at that path and do not delete the branch, because the run using them has not finished with either. Or run this under a different --name.`;
    }
    // Which command to name is the same question `occupiedRefusal` asks, and it has to be asked
    // here too: this path is only reached once the `occupied` check has established that nothing is
    // at the target, so the live cases are a registration whose directory has already been deleted
    // — where `git worktree remove` is exactly right — and a branch nothing has ever held, where it
    // exits 128 with `fatal: '<path>' is not a working tree`. Naming the removal "first"
    // unconditionally told the second operator that the command they need is blocked behind one
    // that refuses. `unknown` names both, and claims neither.
    //
    // What `unregistered` may claim is bounded to the target. It asked about one path, so "there is
    // nothing to remove first" was a claim about the whole repository that the question did not
    // support: an operator who has the same branch checked out in a worktree of their own — theirs,
    // anywhere on disk — gets `error: cannot delete branch ... used by worktree at <somewhere else>`,
    // exit 1, out of the command this sentence told them would work. Reproduced on git 2.55. So the
    // claim is scoped to `target` and the sentence names what answers the other case.
    //
    // The removal arm is the *unlocked* registration only, which is what makes its parenthetical
    // true: `git worktree prune` clears a stale registration, but not a locked one — verified on git
    // 2.55, where a locked entry stayed listed after `prune` even with its directory deleted. The two
    // locked answers get their own arm, and reaching them here means something more specific than it
    // does on the occupied path: awcli only gets this far because nothing is at the target, and a
    // live `git worktree add` has made its directory before it registers anything. So a registration
    // locked `initializing` with no directory under it is an add that was killed rather than one in
    // flight — which is precisely the leftover this module's own failed-add path can produce.
    const held = await worktreeRegistration(git, repositoryPath, target);
    const unlockFirst = `"git worktree remove" refuses a locked registration and so does "--force" — git asks for "-f -f" — and "git worktree prune" will not clear it either, so "git worktree unlock ${shellPath(target)}" and then "git worktree remove ${shellPath(target)}" is what releases the branch, or "git worktree remove -f -f ${shellPath(target)}" in one step.`;
    const thenDelete = `Then "git branch -d ${branch}", which refuses while the branch holds work no other branch has, and prints git's own "-D" form to insist with.`;
    const remedy =
      held.answer === "registered"
        ? `If it is finished with, remove the working copy that holds it first with "git worktree remove ${shellPath(target)}" (which works even if that directory has already gone, and "git worktree prune" clears every stale registration at once), then "git branch -d ${branch}" — which refuses while the branch holds work no other branch has, and prints git's own "-D" form to insist with.`
        : held.answer === "initializing"
          ? `git still has a working copy registered at ${printable(target, PATH_LIMIT)}, locked with the reason "${INITIALIZING_LOCK}", and nothing is at that path — which is a "git worktree add" that was killed part-way rather than one running now, and it is what goes on holding this branch. ${unlockFirst} ${thenDelete}`
          : held.answer === "locked"
            ? `git still has a working copy registered at ${printable(target, PATH_LIMIT)} and locked, ${held.reason.length === 0 ? "with no reason recorded" : `for the recorded reason "${printable(held.reason)}"`}, and that registration is what holds this branch. Somebody locked it deliberately, so look at what the lock is for before you clear it. ${unlockFirst} ${thenDelete}`
            : held.answer === "unregistered"
              ? `If it is finished with, "git branch -d ${branch}" deletes it once nothing else needs the commits on it — git refuses while the branch holds work no other branch has, and prints its own "-D" form to insist with. git has no working copy registered at ${printable(target, PATH_LIMIT)}, so there is nothing to remove there first; if it refuses naming a working copy instead, "git worktree list" says which one.`
              : `If it is finished with, "git branch -d ${branch}" is the delete, and it refuses while the branch holds work no other branch has — git prints its own "-D" form to insist with. If it refuses naming a working copy that still holds the branch, "git worktree remove ${shellPath(target)}" clears that registration first ("git worktree prune" clears every stale one at once, and neither touches a registration somebody has locked — "git worktree unlock ${shellPath(target)}" comes first for one of those). awcli could not ask git which of these this is.`;
    return `awcli will not cut the branch ${branch} for the "${runName}" run: it already exists, and awcli never moves or deletes a branch — the commits on one are the deliverable. ${remedy} Or run this under a different --name.${unshowablePathNote(target)}`;
  }
  const where =
    collision.kind === "below"
      ? `the branch ${collision.ref} already exists beneath it, and git cannot hold a branch and a directory of branches at the same name`
      : `the branch ${collision.ref} already exists, and git cannot hold a branch and a directory of branches at the same name`;
  // Only where a different run name would actually produce a different answer. `awcli` blocks every
  // branch under `awcli/`, so for that one rename-or-delete is the whole remedy and offering
  // `--name` beside it sends the operator to try something that fails identically.
  const alsoRename =
    collision.kind === "namespace" ? "" : " Or run this under a different --name.";
  return `awcli cannot cut the branch ${branch} for the "${runName}" run: ${where}. That branch is not one of awcli's — awcli only ever creates branches under ${BRANCH_NAMESPACE}/<run>/<slot> — so rename or delete it.${alsoRename}`;
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
          `awcli could not read the commit the working copy at ${printable(dir, PATH_LIMIT)} is on: git rev-parse exited ${answer.code}. ${gitComplaint(answer.stderr)}`,
        );
      }
      return answer.stdout.trim();
    },
    dirty: async () => {
      // `NO_HOOKS`, which this was the one git call in the module without — and the only one an agent
      // could reach more than once. `git status` writes the index whenever it has to refresh stat
      // information, and writing it runs `post-index-change`, resolved through the *shared*
      // `.git/hooks` and the shared config's `core.hooksPath` exactly as `post-checkout` and
      // `reference-transaction` are. So a hook any agent in any slot can plant was handed execution
      // on the host with the operator's identity on every `dirty()` call, for the whole life of the
      // run, by the one member a workflow calls repeatedly — later and more often than the two
      // provisioning calls that already carried the argument, and after AWCLI-25's boundary is
      // supposed to be what stands between an agent and the host. It also made `describe`'s "awcli
      // ran none of the repository's git hooks" false in the tense that sentence is now written in,
      // which says *making it and reading it*. Verified on git 2.55 both ways, under awcli's exact
      // argv: with `post-index-change` planted and the index needing a refresh the hook ran, and the
      // same call under this `core.hooksPath` did not.
      //
      // The filter residual is not closed by this and is not meant to be: `core.hooksPath` governs
      // hooks and says nothing about `filter.<driver>.clean`, which `git status` still runs from the
      // same shared config. That is the half BR-015 states rather than removes — see `describe` and
      // the module header.
      //
      // `status.showUntrackedFiles` pinned the same way, and for a reason found in the suite rather
      // than in the code: `status.showUntrackedFiles=no` is a common setting on a large repository,
      // and under it `git status --porcelain` says nothing about untracked files at all. This answers
      // "what would a resumed run inherit", and an untracked file is something it would inherit — so
      // on that operator's machine the honest answer was silently a different answer from the one CI
      // gives. `-c` on the invocation rather than a wider scrub, because everything else the
      // operator's configuration says about status is theirs to say.
      const answer = await run(
        git,
        [...NO_HOOKS, "-c", "status.showUntrackedFiles=normal", "status", "--porcelain"],
        dir,
      );
      if (answer.code !== 0) {
        throw new Error(
          `awcli could not tell whether the working copy at ${printable(dir, PATH_LIMIT)} has uncommitted changes: git status exited ${answer.code}. ${gitComplaint(answer.stderr)}`,
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
 * than caution: "sandbox" and "worktree" both read as a machine boundary and neither is one. The same
 * rule is why the worktree sentence names `.awcli/run/`: "your own checkout is untouched" was
 * unqualified, and the BR-030 amendment exists because it was not true — a run leaves an untracked
 * directory there, and AWCLI-13's own non-functional criterion was rewritten to carve it out. The
 * carve-out reached the ticket, the rules file and the test; this is the one string an operator ever
 * reads, so it is the place it most needed to land. What it
 * must not do is state the *other* axis's answer. The filesystem outside the repository, the network
 * and this machine's credentials named as reachable are all properties of running on the host, and
 * this type carries no execution target — deliberately, for the reason `WorkspaceIsolation` gives.
 * The BR-015 scenario that wants that sentence is scoped to an agent running *without a container*,
 * and a worktree composed with one (AWCLI-19) would reuse this description to tell the operator their
 * credentials are reachable inside a container that blocks them. So each axis says its own half, and
 * whatever composes them into the contract's `Isolation` says both.
 *
 * The hooks clause carries its own bound for the same reason the `.awcli/run/` carve-out does. What
 * `NO_HOOKS` buys is that no hook runs; it does not buy "no code from the repository runs", because
 * a `filter.<driver>` command runs for every path `.gitattributes` assigns to a driver, and
 * `.git/config` is shared by every worktree — so an agent in one slot can arrange for the next
 * provisioning, any run, to execute a command on the host. Verified against git 2.55 under awcli's
 * exact argv, `core.hooksPath` in force. The module header carries the residual and the operator does
 * not read the module header, so the unqualified version of this clause promised more than the code
 * delivers: precisely the direction BR-015 exists to stop.
 *
 * And the clause says *making it and reading it*, which is the second correction to the same
 * sentence. Bounded to "a checkout", it named the residual and then put it in the past: the reader
 * is told a command ran once, while provisioning. `dirty()` runs `git status`, `git status` runs the
 * `clean` half of the same driver, and `dirty()` is a `WorkspaceHandle` member called for the whole
 * life of the run — measured under awcli's exact `status` argv on git 2.55, see the module header. So
 * the one sentence BR-015 governs understated *when* the residual applies, which is the same class of
 * error as understating that it applies at all.
 *
 * Both interpolations are sanitised, and the asymmetry that made that necessary is worth stating: the
 * branch used to arrive pre-sanitised from `openLiveTree` and `dir` arrived raw, so this string
 * hardened the narrower of its two foreign values and left the wider one open. A git ref cannot carry
 * a C0 control — git's ref rules ban them, and `git check-ref-format` refuses `refs/heads/a<ESC>b`,
 * measured — while a directory name may hold any byte but NUL and `/`, and `git rev-parse
 * --show-toplevel` hands the path back byte for byte, ESC included (measured on git 2.55 against a
 * repository whose directory name carried U+001B and U+202E). So `dir` was the channel that could
 * repaint the terminal, on the success path, in the one string an operator always reads.
 * `WorkspaceHandle.dir` and `.branch` stay the real values; sanitising is what printing them costs.
 */
function describe(workspace: WorkspaceAxis, dir: string, branch: string): string {
  const where = printable(dir, PATH_LIMIT);
  const on = printable(branch, PATH_LIMIT);
  return workspace === "liveTree"
    ? `Working directly in your own checkout at ${where}, on your branch ${on}, because this run was given ${LIVE_CHECKOUT_FLAG}: uncommitted changes there are an agent's to change, and nothing about the working copy protects them. What an agent can touch beyond your checkout is settled by where this run executes, not by the working copy it was given.`
    : `Working in a worktree at ${where}, on the branch ${on}: your own checkout, its branch and its uncommitted changes are untouched — the one thing this run adds to your checkout is the working copy itself, under .awcli/run/ — and awcli ran none of the repository's git hooks to make it, though git still runs any content filter the repository configures, both to make this working copy and to read it. That is the whole of what a working copy protects: it is not a boundary around the machine, and what an agent can touch beyond this directory is settled by where this run executes, not by the working copy it was given.`;
}

/**
 * A fault `run` raised itself, because git never started.
 *
 * The two shapes it covers — `unavailable` and `no-such-directory` — are the ones where nothing of
 * git's happened, so nothing of git's can have been left behind. That matters one caller along: the
 * branch cut's handler appends a residual about a ref that "may exist", which is true of the three
 * shapes where git *ran* and false of these two. A class rather than a flag on the message, because
 * the outcome that would answer the question is no longer in hand where the distinction is needed,
 * and matching on the prose of a sentence is how the wrong version of this shipped.
 */
class GitDidNotRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDidNotRunError";
  }
}

/**
 * git, with the cases that are not an answer turned into faults.
 *
 * Only `sharedPreflight` asks whether git can be run, because it is the first thing to ask and the
 * answer cannot change during one acquisition. Everything after it is entitled to assume git exists,
 * and a git that has become unavailable *between* two calls in the same acquisition is a machine
 * changing under a run, which is a fault and not a choice the operator can make differently.
 *
 * Both faults are `GitDidNotRunError`, and that is contract rather than tidiness: they are the two
 * shapes in which no git process ran, which is what lets a caller tell "awcli may have left a ref
 * behind" from "nothing happened". See there.
 */
async function run(
  git: GitRunner,
  args: readonly string[],
  cwd: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const outcome = await git(args, cwd);
  if (outcome.kind === "unavailable") {
    throw new GitDidNotRunError(
      `awcli could not run git in ${printable(cwd, PATH_LIMIT)} (${printable(outcome.reason)}), having already run it once in this repository. git has gone missing while the run was starting.`,
    );
  }
  // Distinct from the above for the same reason the outcome is: the preflight already started git in
  // this repository, so "git has gone missing" is the wrong sentence for a spawn that failed on
  // permissions or on a machine at its process limit. Both are faults here — the preflight proved
  // this repository was startable — but they are different faults and an operator acts on them
  // differently.
  if (outcome.kind === "not-started") {
    throw new GitDidNotRunError(
      `awcli could not start git in ${printable(cwd, PATH_LIMIT)} (${printable(outcome.reason)}), having already started it once in this repository. git is still on the machine; something about this call or this moment stopped it running — a directory that stopped being enterable, or a machine that has run out of processes or file descriptors.`,
    );
  }
  if (outcome.kind === "no-such-directory") {
    // The preflight established that this directory exists, so it has gone since — a run's own
    // repository being removed underneath it is a fault, not something to offer a flag for.
    throw new GitDidNotRunError(
      `awcli could not run git in ${printable(cwd, PATH_LIMIT)}: that directory is no longer there, and it was when this run started.`,
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

/**
 * A component of the layout awcli can use: a real directory, and not a link to one.
 *
 * Both faults quote the component through `printable`, on `assertInsideRuntimeDirectory`'s reasoning
 * rather than a weaker version of it. The layout descends from `rev-parse --show-toplevel`, which
 * hands a repository path back byte for byte — measured on git 2.55 against a directory name carrying
 * U+001B and U+202E — and a directory name may hold any byte but NUL and `/`. These two guards fire
 * precisely when somebody has put something in the layout that awcli will not use, so the value they
 * quote is one an attacker had a hand in.
 */
function assertUsableDirectory(ancestor: string, stats: Stats): void {
  if (stats.isSymbolicLink()) {
    throw new Error(
      `${printable(ancestor, PATH_LIMIT)} is a symbolic link, and awcli will not follow one to reach a run's working copies: the working copy, and everything an agent writes in it, would land outside the repository. Remove it and run again.`,
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
      `${printable(ancestor, PATH_LIMIT)} is a file, and awcli needs a directory there to hold this run's working copies. awcli never writes over what it finds: move or remove it and run again.`,
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
      `awcli cannot create a working copy in ${printable(directory, PATH_LIMIT)} (${errnoOf(error) ?? "permission denied"}): that directory is not writable. Check its permissions, or run against a repository this user can write to.`,
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
