/**
 * The awcli context contract — the entire API a workflow author writes against.
 *
 * This file is authored, not generated: the declaration is the specification and awcli's
 * runtime is checked against it at build time (ADR-0002). It is the artifact awcli publishes
 * into a target repository so the author has something to type against; AWCLI-22 does the
 * writing, and until it lands this file only ever compiles here.
 *
 * That destination is why it is a script-mode declaration with **no top-level import and no
 * top-level export** — every name below is global. A target repository may be a Python or Go
 * project with no package manifest and no installed packages (BR-032), so a workflow file
 * must type-check with zero imports, and nothing here may name a Node built-in, a type
 * package, or any dependency. A single top-level import turns this into a module and every
 * name in it vanishes from the author's editor; test/contract/standalone-declaration.test.ts
 * exists to catch exactly that.
 *
 * **Not every member described here runs on every awcli.** The contract is frozen ahead of
 * the machinery behind it (BR-033), so a given build declares members it has not implemented,
 * and calling one fails rather than doing nothing. Every member of WorkflowContext this build
 * has not built says so in its own comment, in as many words. Ask
 * ctx.version.supports("agent") before calling a member you have not seen work; that predicate
 * answers for this build, and it and those disclosures are the only things in this file that
 * describe the present rather than the contract.
 *
 * Additive-only within a major version (BR-033). A member may be added; none may be removed
 * or narrowed. Workflows are committed code calling this surface, and the semver major is the
 * only breaking-change signal the version range gate has (BR-003). Adding a member, adding an
 * optional property, or widening an argument type is additive. Anything a previously-valid
 * workflow would no longer compile against is not.
 *
 * Every function on this surface is a `readonly` property holding an arrow type. The arrow is
 * for strictFunctionTypes, which method syntax opts out of (see WorkflowContext); the
 * `readonly` is so that nothing sharing a context can substitute one. A workflow's module graph
 * is whatever it imports, and a helper somewhere inside it assigning `ctx.log.info = () => {}`
 * would silence the audit trail BR-025 and BR-028 depend on, or swap a confinement-enforcing
 * function after sandbox() has handed out a scoped context.
 *
 * A declaration is a compile-time claim and BR-025 asks for more than one: an assignment over
 * log.info is refused, not merely unspellable. awcli freezes the context and every sub-API on
 * it, so the assignment throws in a module rather than quietly succeeding for a caller that
 * reached this surface without the declaration. The `readonly` here is what makes the same
 * mistake fail at the keyboard instead.
 */

/** A commit as git reports it. Commits are the deliverable of an agent call (ADR-0004). */
interface Commit {
  /** Full object id. An abbreviation is only unique in one repository at one moment. */
  readonly sha: string;
  /** First line of the commit message. */
  readonly subject: string;
}

/**
 * What a value must be to survive the crossing to disk and back (BR-008).
 *
 * Shared state outlives the process, so a live handle — a stream, a class instance, a
 * function — cannot go into it.
 *
 * This type constrains nothing a workflow writes, and after v1 it never did. State assignments
 * are not policed by it: WorkflowState is State & { save }, and State is deliberately
 * unconstrained, so BR-008 is enforced at run time — awcli rejects an unstorable value at the
 * assignment that set it, naming the key. Log fields are not policed by it either; they are
 * `unknown`, and LogApi says why. Its last appearance on this surface is as the type
 * ctx.schema.storable() narrows to.
 *
 * That is the whole of its job, and it is not a small one. BR-008 has to be checked against
 * something, and this is what awcli checks against when a value lands: the vocabulary of what
 * comes back intact. A workflow that wants the answer before the assignment asks for it with
 * ctx.schema.storable(). What no longer exists anywhere is a caller this type refuses at
 * compile time — widening it would not break a single call site, which is why
 * test/fixtures/v1-rejected/storable.ts pins the type by construction instead.
 */
type Storable =
  | null
  | boolean
  | number
  | string
  | readonly Storable[]
  | { readonly [key: string]: Storable };

/** The verdict of a validation: the narrowed value, or every reason it was refused. */
type SchemaCheck<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * A validator for one shape.
 *
 * Structural on purpose. A target repository cannot install a validation library, so a schema
 * here is anything with a check method — a hand-written predicate, or a thin adapter around
 * whatever the author does happen to have. `readonly` costs that nothing: TypeScript ignores
 * the modifier when it relates two types, so an object whose own `check` is writable still
 * satisfies this.
 *
 * There are no constructors for building one. That is a real gap for an author who wants
 * BR-009 state validation without a library, and it is a gap that can be closed additively;
 * freezing a combinator vocabulary now would be guessing at one.
 */
interface Schema<T = unknown> {
  readonly check: (value: unknown) => SchemaCheck<T>;
}

/**
 * ctx.schema — the rules awcli applies that a workflow cannot reimplement.
 *
 * Only that. Validating a value against a schema is schema.check(value), so a second way to
 * spell it would be frozen surface that can never do anything the caller could not already
 * do.
 */
interface SchemaApi {
  /**
   * Whether a value can be written to shared state (BR-008). awcli applies this at every
   * assignment; a workflow can apply it first to decide what is worth keeping, rather than
   * discovering at the assignment that a value cannot cross an iteration boundary.
   */
  readonly storable: (value: unknown) => SchemaCheck<Storable>;
}

/**
 * How isolated a call actually was, on both axes (ADR-0003).
 *
 * Reported at every agent call, because a working copy protects the repository and nothing
 * else — the filesystem outside it, the network and the credentials all stay reachable on the
 * default path, and an operator who reads "sandbox" will assume otherwise (BR-015).
 *
 * Nothing a workflow can pass selects the workspace axis, and that is deliberate. The live
 * checkout is opted into by the operator on the command line (`awcli run --live-checkout`), never
 * by the workflow: BR-014 requires the person whose uncommitted work is at stake to be the one
 * asking, and it keeps one workflow file portable across both modes.
 *
 * The flag is spelled `--live-checkout`, which is what LIVE_CHECKOUT_FLAG in
 * src/runtime/workspace.ts refuses on and what every refusal message names. This line said
 * `--live` until the 2026-08-28 `--live-checkout` amendment, and so did the CLI table in the TDD.
 * Two spellings of one operator-facing string is the kind of drift a frozen surface exists to
 * prevent, so both were reconciled to the one the code ships. It also said AWCLI-13 implements
 * the flag, which that ticket's own Out of Scope contradicts. Three tickets stand behind it:
 * AWCLI-13 resolves the choice and provisions what it names, AWCLI-20 parses the flag off
 * `awcli run`, AWCLI-21 states the answer in the run's output. None of the three adds anything
 * here — this is a comment, and BR-033 admits only additive changes to what is declared below.
 *
 * Both unions are closed, and stay closed. ADR-0003 defines exactly two values per axis, so a
 * third is a change to the model rather than a new option, and it deserves the major version
 * that adding it would cost. Leaving them open would take exhaustiveness away from every
 * author to accommodate a case the design does not have.
 *
 * Two independent fields rather than a union of the permitted pairs, and that costs something:
 * liveTree × container is expressible here, and ADR-0003 excludes that cell as meaningless.
 * awcli never produces it — sandbox() fixes worktree × container, and the live checkout only ever
 * runs on the host — but nothing in this type says so. Read the pair as two facts reported about
 * a call, not as the set of states a call can be in. Closing the gap would mean replacing the two
 * fields with a three-member union, which is a change to the frozen surface rather than a comment.
 */
interface Isolation {
  /** worktree is the default; liveTree is the operator's own checkout, opt-in only (BR-014). */
  readonly workspace: "liveTree" | "worktree";
  /** Only container is a machine boundary. host reaches the filesystem and network. */
  readonly target: "host" | "container";
  /** One line for the log, naming what is and is not protected (BR-015). */
  readonly description: string;
}

/**
 * What a call cost, where the agent said so.
 *
 * Every field is optional because usage comes from the agent CLI's private event stream,
 * which may not carry it and may change shape without notice. It degrades to unknown rather
 * than failing a run (ADR-0004, BR-026).
 */
interface Usage {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly costUsd?: number | undefined;
}

/**
 * What to ask an agent for.
 *
 * T is the type of AgentResult.output: the agent's text unless output is given, in which case
 * it is whatever that schema validates to.
 *
 * A prompt leaves the machine. Everything interpolated into one reaches a third-party model
 * and is recorded in this call's log (BR-028), so a workflow must decide deliberately what
 * goes in — a value read out of ctx.env in particular is not material to paste into a prompt.
 *
 * Every optional here admits undefined explicitly. awcli does not control the author's
 * compiler flags, and under exactOptionalPropertyTypes a bare `model?: string` refuses
 * `agent({ prompt, model: undefined })` — which is what building options up conditionally
 * produces. Widening is additive; narrowing back later would not be.
 */
interface AgentOptions<T = string> {
  /** The prompt, inline. */
  prompt: string;
  /**
   * A file whose contents join the prompt — for one too long to sit in the workflow.
   *
   * Resolved within the working copy's tree and confined to it, on the same terms as
   * ctx.fs.read: a path escaping the tree is refused rather than resolved. This one is the
   * sharper of the two, because its contents are transmitted off the machine by construction.
   */
  promptFile?: string | undefined;
  /** Overrides the model the repository declares as its default. */
  model?: string | undefined;
  /**
   * Ask for a tagged, validated block. The resolved prompt must actually ask the agent for
   * this tag, or the run is refused at startup rather than after all the work (BR-007). A
   * block that fails the schema costs one narrow re-ask and then the iteration — never the
   * run, because the agent's real work is already committed (BR-020).
   *
   * Both fields are required, and the required-key witnesses in
   * test/fixtures/v1-corpus/construction.ts are the only thing that says so structurally:
   * conformance.ts never reaches inside AgentOptions, and an object literal supplying both
   * compiles whether or not the declaration still asks for them.
   */
  output?: { tag: string; schema: Schema<T> } | undefined;
  /** Wall-clock ceiling for this one call. */
  timeoutSeconds?: number | undefined;
  /** Slot name. Distinguishes parallel agents in logs and branch names (BR-013, BR-036). */
  name?: string | undefined;
}

/** What an agent call produced. */
interface AgentResult<T = string> {
  /** From the repository, not from the agent's output — the work is what it committed (ADR-0004). */
  readonly commits: readonly Commit[];
  /** The validated block when output was asked for, otherwise the agent's text. */
  readonly output: T;
  /** What isolation this call actually had, never what was hoped for (BR-015). */
  readonly isolation: Isolation;
  /** Absent when the agent did not report it, which is normal (ADR-0004). */
  readonly usage?: Usage | undefined;
  /** This call's own log. The terminal only carried a summary of it (BR-028). */
  readonly logPath: string;
}

/**
 * What there is to choose about a sandbox: the slot it occupies, and nothing else.
 *
 * Workspace and execution target are orthogonal axes (ADR-0003), and sandbox() is the one
 * composition that fixes both — worktree × container — so no isolation is left to select
 * here. A container that cannot be obtained fails the call; it is never quietly downgraded to
 * the host, because that is the one failure mode that could damage something outside the
 * repository (BR-004).
 */
interface SandboxOptions {
  /** Slot within the run. Fixes the branch, so a resumed run reattaches it (BR-036). */
  name?: string | undefined;
}

/**
 * A sandbox: a working copy of its own, plus a container to run in.
 *
 * State is read-only inside it, which is as far as BR-012 is enforced by the type system
 * today: a scope obtained from sandbox() cannot be written through, and a lost update inside
 * one is invisible until the state is inexplicably wrong hours later. Results leave a scope as
 * return values, and the workflow body records them.
 *
 * A plain ctx.agent() fan-out is the other half of BR-012 and has no structural home yet —
 * agent() hands back a result, not a child context, so branches share the writable body
 * context and awcli enforces the single writer at run time. Giving that case a frozen context
 * of its own is AWCLI-10; because it would be a new member or overload, it stays additive.
 *
 * No runtime is held against this shape. conformance.ts walks the members of ctx and one level
 * into each, and a Scope arrives from behind a function rather than as a member, so the runtime
 * never restates it and there is nothing there to compare. The construction fixture in
 * test/fixtures/v1-corpus is what holds it.
 */
interface Scope<State = Record<string, unknown>> {
  /** The context to use inside the sandbox. */
  readonly ctx: ScopedContext<State>;
  /** What was actually obtained, to state at every agent call made in here (BR-015). */
  readonly isolation: Isolation;
  /**
   * Remove the container and release the working copy. The working copy stays on disk and its
   * branch is never deleted — the commits are the deliverable (BR-021, BR-036).
   */
  readonly dispose: () => Promise<void>;
}

/**
 * Read-only all the way down.
 *
 * A shallow Readonly freezes the reference and leaves the contents writable, so
 * `state.labels.push(x)` from inside a fan-out would still compile — and BR-012 has no
 * exceptions.
 *
 * One mapped type covers arrays, tuples and plain objects, rather than an array branch of its
 * own. A homomorphic mapped type over `keyof T` is the form TypeScript carries across an array
 * or a tuple intact, so `[string, number]` comes back as `readonly [string, number]` with both
 * positions and its length. Mapping the element type instead — `readonly DeepReadonly<E>[]` over
 * an inferred E — reads more naturally and flattens a tuple to `readonly (string | number)[]`,
 * which loses every position a workflow would index and turns `.length` from `2` into `number`.
 *
 * It walks whatever shape the author declared, which nothing constrains: BR-008 rejects an
 * unstorable value at run time, but a state shape declaring a Date or a Map still reaches the
 * object branch here and comes back mapped rather than intact. Declare state as plain data
 * and the two rules agree; declare a class instance and this type is the second place it
 * fails, not the first.
 */
type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** The workflow's own surface with the single-writer rule applied to it (BR-012). */
type ScopedContext<State = Record<string, unknown>> = Omit<
  WorkflowContext<State>,
  "state"
> & {
  readonly state: DeepReadonly<State>;
};

/**
 * Shared state: a plain mutable record that outlives the iteration.
 *
 * Writes are persisted as they happen rather than at the iteration boundary, so a crash forty
 * minutes in does not discard what was recorded during it (BR-023). Assignment alone is
 * already durable; save() is the explicit flush for a long iteration that wants a point it
 * knows is on disk, because "as they happen" is debounced and a deadline is not. A value that
 * is not Storable is rejected at the assignment that set it, naming the key (BR-008).
 *
 * save costs a key: a state shape that declares its own `save` intersects with this one and
 * stops being usable. The collision is permanent for v1 and the failure is loud and local —
 * the author's own state declaration stops compiling, at the declaration, rather than
 * misbehaving later.
 */
type WorkflowState<State = Record<string, unknown>> = State & {
  readonly save: () => Promise<void>;
};

/**
 * Commands the repository declares for itself (BR-006).
 *
 * These are strings from the repository's committed configuration, and for awcli's headline
 * use — running an agent against a branch or a pull request — that configuration is content
 * the branch supplied. A workflow handing one to ctx.exec is running whatever the branch put
 * there, on the host, before any container exists. Treat them as the repository's word, not
 * the operator's.
 */
interface ProjectCommands {
  readonly test: string;
  readonly build: string;
  readonly lint: string;
}

/** Paths the repository declares for itself (BR-006). */
interface ProjectPaths {
  readonly docs: string;
  readonly standards: string;
}

/**
 * Facts about the repository, from its committed configuration (BR-006).
 *
 * The fixed fields are present because the repository's configuration is required to declare
 * all five: `awcli init` writes them, and the gate chain refuses the run at startup naming any
 * the configuration lacks — before the lock, the working copy, or any agent. That refusal is
 * what makes the type honest, and it is the only mechanism that keeps BR-006's promise of
 * refusing before any side effect.
 *
 * custom carries no such guarantee: it is the operator's own convention, so its values stay
 * string | undefined whatever compiler flags the author happens to have on.
 *
 * awcli's own configuration — version range, default agent, sandbox options — is not here.
 * Those are facts about awcli rather than about the repository, and a workflow cannot act on
 * them.
 */
interface Project {
  readonly commands: ProjectCommands;
  readonly paths: ProjectPaths;
  /** Free-form, unvalidated, absent-is-normal (BR-006). */
  readonly custom: Readonly<Record<string, string | undefined>>;
}

/**
 * ctx.git — the working copy this iteration is operating in (BR-036).
 *
 * dir is a plain value because awcli chose the path before the workflow ran. The rest ask
 * git, so they are asynchronous and may disagree with a previous answer in the same
 * iteration — an agent commits while the workflow is running, which is the point.
 */
interface GitApi {
  /** Absolute path to the working copy. The directory ctx.exec and ctx.fs operate in. */
  readonly dir: string;
  /** The branch the working copy is on, derived from run and slot (BR-036). */
  readonly branch: () => Promise<string>;
  /** The commit the working copy is currently on. Recorded against the run (BR-025). */
  readonly head: () => Promise<string>;
  /** Whether the working copy has uncommitted changes — what a resumed run inherited. */
  readonly dirty: () => Promise<boolean>;
  /** Commits on this branch that are not on the base it was cut from. */
  readonly log: () => Promise<readonly Commit[]>;
  /** Unified diff of everything uncommitted. */
  readonly diff: () => Promise<string>;
  /** Commit the working copy's current changes; refuses when there is nothing to commit. */
  readonly commit: (message: string) => Promise<Commit>;
}

/** What a command left behind. */
interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What to ask of a command beyond the command itself. */
interface ExecOptions {
  /**
   * Wall-clock ceiling, after which the command is killed and the call rejects.
   *
   * awcli owns the loop (BR-017) and cannot interrupt a command it has no deadline for, so
   * without this a single hung exec outlives --max-duration and BR-018's incomplete exit never
   * fires. Absent means awcli's own default for the run, not "forever".
   */
  timeoutSeconds?: number | undefined;
}

/**
 * ctx.exec — run a command in the current working copy, on the current execution target
 * (BR-032).
 *
 * Two forms, and the difference is the whole point. An array is argv: it is executed directly,
 * no shell, and every element is one argument however it is spelled — this is the form to use
 * whenever a value from elsewhere goes *into* a command the workflow otherwise wrote itself,
 * which covers an --arg value, a path read out of the tree, and anything an agent produced. A
 * string is handed to a shell, because a repository's declared test command is allowed to contain
 * && and pipes and would be meaningless otherwise; a string built by interpolation is a command
 * the interpolated value can rewrite.
 *
 * A repository's declared command is deliberately not on that list, and the reason is worth
 * stating because it looks like an omission. argv protects a command the workflow trusts from a
 * fragment it does not; a declared command is untrusted whole (see ProjectCommands), and passing
 * it as a single argv element would not contain it — that element is the binary to run. So the
 * quoting choice buys nothing there, which is also why ProjectCommands types its entries as shell
 * strings rather than argv. What guards that case is a container, not a form of this call
 * (BR-004, BR-015).
 *
 * On the default execution target there is no container, so a declared command runs with the
 * operator's own reach — the filesystem beyond the working copy, the network, and whatever
 * credentials this machine holds. BR-040 states that rather than leaving it to be inferred, and
 * requires the run to report the target a command actually ran on. Working-tree confinement
 * (BR-038) governs the paths a workflow names, not what a command reaches once it is running.
 *
 * Which execution target this runs on comes from the context rather than from an argument:
 * both axes are fixed when the scope is made (ADR-0003).
 *
 * A non-zero exit is a result, not a throw. A workflow running the repository's test command
 * expects it to fail sometimes — that is why it ran it.
 */
type ExecApi = (
  command: string | readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/**
 * ctx.fs — read and write within the working copy's tree.
 *
 * Paths are resolved against the working copy and confined to its tree: one that escapes, by
 * `..` or by being absolute or through a symlink, is refused rather than resolved. Reaching
 * outside deliberately is what ctx.exec is for — an explicit act, rather than something a
 * mistyped path does by accident.
 *
 * The tree, and not the working copy entire. The git administrative area lies inside the
 * working copy and is refused all the same (BR-038): a hook written there is run by the next
 * commit awcli makes, and on the worktree default the `.git` entry is a single line naming
 * which repository this working copy belongs to, so writing it repoints the working copy at a
 * different repository without any path having left anything.
 *
 * Confinement protects the operator's other files. It is not a boundary around the agent, and
 * the carve-out is not a boundary around the administrative area either: git hooks living in
 * the working copy are executed by ctx.git.commit() and by any ctx.exec that runs git and they
 * run with the workflow's own reach, and a command the workflow runs may still write anything
 * there, on BR-040's terms. Only a container is a boundary (BR-015).
 */
interface FsApi {
  readonly read: (path: string) => Promise<string>;
  readonly write: (path: string, contents: string) => Promise<void>;
}

/**
 * ctx.log — structured logging, already attributed to the run, iteration and agent (BR-025).
 *
 * Output goes to this call's own log file and the terminal carries a summary, because four
 * parallel agents interleaved on one terminal is unreadable, and the detail is exactly what is
 * wanted afterwards (BR-028).
 *
 * A field value is `unknown` rather than Storable. BR-008 still governs both state and a log
 * field, and on both it is enforced at run time — this was the last place on the surface where
 * Storable refused a caller at compile time, and widening it here removes that. What it did not
 * do was make state safer: State is an unconstrained type parameter, so a state assignment was
 * never compile-checked against Storable and is not now.
 *
 * Where the two differ is what run time then does. State crosses to disk *and back*, so a value
 * that cannot make the round trip is one the next iteration cannot read, and awcli refuses it at
 * the assignment that set it, naming the key; ctx.schema.storable() is how a workflow asks the
 * same question first. A log line crosses once and is never read back into a workflow, so a
 * field is BR-008's business at serialisation only — awcli writes what it can represent and says
 * so where it cannot, rather than refusing the call.
 *
 * Typing the fields Storable put that refusal in the worst possible place. The values most
 * worth logging are this contract's own return types, and an interface has no implicit index
 * signature, so `ExecResult`, `Commit` and `ctx.args` were each rejected by a field record that
 * a bare string or number sailed through. What the refusal bought was a call site spreading a
 * result by hand, or logging less than it meant to, to satisfy a constraint a log line does not
 * need. `unknown` also subsumes the undefined case a log has always had to carry: spend the
 * agent did not report (ADR-0004), an argument nobody passed.
 *
 * A log is durable and is read later by people and by other agents. awcli redacts values
 * matching known secret shapes from logs and run records, which is a net cast over shapes it
 * recognises rather than a guarantee about a value it does not — logging a credential on
 * purpose still writes it down. The workflow decides what is worth recording.
 */
interface LogApi {
  readonly info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly warn: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly error: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
}

/**
 * ctx.env — the environment the execution target resolved for this run, one name at a time.
 *
 * An accessor and not a record, and the shape is the rule. What survives the subtraction below
 * is the operator's own environment, which is theirs and may hold secrets of its own, so this
 * is somewhere to read a specific known variable from and not somewhere to enumerate and
 * forward. `Readonly<Record<string, string | undefined>>` was the earlier spelling, and it made
 * enumerate-and-forward the default affordance while only advising against it in prose: a
 * record goes wherever a record is taken, and `ctx.log.info("env", ctx.env)` type-checked
 * against a field record and wrote every variable the operator had set into a durable file.
 * Neither move can be spelled through get and has. There is no listing member; adding one is
 * additive, so its absence is a decision that stays open rather than one this type could never
 * revisit.
 *
 * The variables awcli sets for a run are meant to be absent from what this answers. The ones
 * that matter are the agent credentials it lends a container as a read-only mount for the life
 * of the run and never copies (BR-016); answering with one would copy it into every prompt and
 * every run record that reads it, which is the thing BR-016 exists to prevent.
 *
 * What awcli set is the whole of the test, and it is a lookup rather than a judgement: awcli
 * knows which names it set at the moment it sets them, so nothing here rests on recognising
 * what looks like a credential. An agent API key the operator set themselves is present, value
 * included, because awcli did not set it (BR-039). On the host target awcli often sets nothing,
 * and the answers are then the operator's environment unchanged, with nothing withheld. A name
 * awcli removed is indistinguishable from one that was never set.
 *
 * That subtraction is a promise about the environment awcli resolves, not something this type
 * states or enforces — and it is not built. BR-039 governs it and AWCLI-24 delivers it, so on
 * this build both members refuse rather than answering out of an unfiltered environment; ask
 * ctx.version.supports("env") first (BR-033). Read the promise as what the member must do
 * before it can ship, not as what a present awcli does.
 *
 * awcli redacts values matching known secret shapes from logs and run records, which is a net
 * over shapes it recognises rather than a guarantee about a value it does not. A value read
 * from here and logged on purpose is still written down.
 */
interface EnvApi {
  /** One variable's value, or undefined when it is unset or awcli removed it (BR-039). */
  readonly get: (name: string) => string | undefined;
  /** Whether one variable is present. False for a name awcli removed, as for one never set. */
  readonly has: (name: string) => boolean;
}

/**
 * ctx.version — what a workflow needs in order to run against a binary newer than itself
 * (BR-033).
 */
interface ContractVersion {
  /**
   * The contract's own version, major.minor.patch. Additive within a major, so a workflow
   * written against 1.2 runs unchanged on 1.9. A 2.x binary is refused by the repository's
   * declared range before the workflow is ever called (BR-003).
   */
  readonly contract: string;
  /** The awcli build that supplied this context, as recorded against the run (BR-025). */
  readonly awcli: string;
  /**
   * Whether a member can actually be called on this awcli.
   *
   * Callable, not declared — and the difference matters. The contract is frozen ahead of the
   * machinery behind it (BR-033), so this binary declares members it has not built. Answering
   * "is it in the contract" would return true for those, and a workflow following the
   * instruction to feature-detect would crash on the very branch it took to avoid crashing.
   *
   * Takes a string rather than a union of the names below, on purpose: the question worth
   * asking is about a member that did not exist when the workflow was written, and a union of
   * today's names cannot express that question.
   *
   * **Top-level member names only.** A dotted name — "git.push" — always answers false: not
   * because the method is missing, but because this predicate does not answer questions about
   * sub-APIs at all. It will keep answering false after git.push ships, so using it that way
   * skips a member that works. Ask supports("git"), then call the method. Teaching it dotted
   * names is additive if it ever earns its place.
   */
  readonly supports: (member: string) => boolean;
}

/**
 * Everything a workflow is given. Injected, never imported (ADR-0002, BR-032).
 *
 * State is the shape of shared state. Declare it, export a matching state schema, and stored
 * state is validated on load instead of surfacing a renamed field as undefined hours in
 * (BR-009). It is left unconstrained rather than bounded by Record<string, unknown>, because
 * an interface does not satisfy that constraint and an interface is how an author will write
 * their state shape.
 *
 * Every function on this surface — here and in the sub-APIs above — is a `readonly` property
 * holding an arrow type rather than a method. The arrow is for strictFunctionTypes: method
 * syntax is bivariant in its parameters, which would let a runtime narrowing
 * `commit(message: "feat")` pass as a GitApi and the conformance check see nothing, and callers
 * cannot tell the two apart. The `readonly` is so that nothing sharing a context can substitute
 * one. The two cannot both be had any other way — `readonly` on method syntax is an error
 * (TS1024), which is the second reason not to write a method here.
 *
 * A member this build has not implemented says so in its own comment below. That is a statement
 * about this build rather than about the contract, so it is the one thing here meant to go out
 * of date: a member's disclosure goes when the member ships, and
 * test/contract/unbuilt-disclosure.test.ts holds these comments and the runtime's own table of
 * unbuilt members to each other in both directions.
 */
interface WorkflowContext<State = Record<string, unknown>> {
  /**
   * Run an agent and wait for it (BR-013, BR-020, BR-022).
   *
   * Not built on this awcli: calling it refuses rather than doing nothing, so ask
   * ctx.version.supports("agent") first (BR-033).
   */
  readonly agent: <T = string>(options: AgentOptions<T>) => Promise<AgentResult<T>>;
  /**
   * Obtain a container and a working copy of its own (BR-004, BR-016).
   *
   * Not built on this awcli: calling it refuses rather than doing nothing, so ask
   * ctx.version.supports("sandbox") first (BR-033).
   */
  readonly sandbox: (options?: SandboxOptions) => Promise<Scope<State>>;
  /**
   * Shared state: mutable in the body, read-only inside a scope (BR-008, BR-012, BR-023).
   *
   * Not built on this awcli: reading it refuses rather than handing back an empty record, so
   * nothing reachable through it — save() included — can be held. Ask
   * ctx.version.supports("state") first (BR-033).
   */
  readonly state: WorkflowState<State>;
  /**
   * Whatever was passed as --arg key=value. An argument not passed is absent.
   *
   * Not built on this awcli: reading it refuses rather than handing back an empty record, so
   * ask ctx.version.supports("args") first (BR-033).
   */
  readonly args: Readonly<Record<string, string | undefined>>;
  /**
   * What the repository declares about itself (BR-006).
   *
   * Not built on this awcli: reading it refuses rather than handing back a blank profile, so
   * ask ctx.version.supports("project") first (BR-033).
   */
  readonly project: Project;
  /**
   * The working copy this iteration is operating in (BR-036).
   *
   * Not built on this awcli: reading dir refuses and calling any of the rest refuses, so ask
   * ctx.version.supports("git") first (BR-033).
   */
  readonly git: GitApi;
  /**
   * Run a command here (BR-032).
   *
   * Not built on this awcli: calling it refuses rather than doing nothing, so ask
   * ctx.version.supports("exec") first (BR-033).
   */
  readonly exec: ExecApi;
  /**
   * Read and write here, within the working copy's tree (BR-038).
   *
   * Not built on this awcli: calling either member refuses rather than doing nothing, so ask
   * ctx.version.supports("fs") first (BR-033).
   */
  readonly fs: FsApi;
  /**
   * Say something, attributably (BR-025, BR-028).
   *
   * Not built on this awcli: calling any of the three refuses rather than dropping the line,
   * so ask ctx.version.supports("log") first (BR-033).
   */
  readonly log: LogApi;
  /**
   * Read one variable of the environment resolved for this run (BR-039).
   *
   * Not built on this awcli: calling either member refuses rather than answering out of an
   * unfiltered environment, so ask ctx.version.supports("env") first (BR-033).
   */
  readonly env: EnvApi;
  /**
   * The rules awcli applies that a workflow cannot reimplement (BR-008).
   *
   * Not built on this awcli: calling it refuses rather than approving everything, so ask
   * ctx.version.supports("schema") first (BR-033).
   */
  readonly schema: SchemaApi;
  /** Feature-detect rather than crash (BR-033). The one member every build has. */
  readonly version: ContractVersion;
}

/** What a workflow may return from an iteration. */
interface WorkflowResult {
  /**
   * End the loop. awcli first awaits agents still in flight, so their commits land intact
   * rather than being cut off mid-write (BR-037).
   */
  done?: boolean | undefined;
}

/** The optional limits export: how this workflow wants a limit exhaustion classified. */
interface WorkflowLimits {
  /**
   * Whether exhausting --iterations or --max-duration counts as having finished.
   *
   * Defaults to false when the export is absent: a run that stopped because it ran out of
   * budget exits 2 (incomplete), not 0, so a scheduler is never told a job succeeded when it
   * was merely cut short (BR-018).
   */
  exhaustionIsCompletion: boolean;
}

/**
 * A workflow's default export, invoked once per iteration (BR-017).
 *
 * Written with no import at all:
 *
 *     const workflow: Workflow = async (ctx) => { ... };
 *     export default workflow;
 *
 * Returning nothing means "call me again". Returning { done: true } ends the loop.
 */
type Workflow<State = Record<string, unknown>> = (
  ctx: WorkflowContext<State>,
) => Promise<WorkflowResult | void>;

/**
 * The whole module contract, for reference and for the loader to validate against.
 *
 * A file with no default export, or whose default export is not callable, is refused before
 * any run state exists — a missing entry point is a typo, not a run (BR-005).
 */
interface WorkflowModule<State = Record<string, unknown>> {
  readonly default: Workflow<State>;
  /** Absent means { exhaustionIsCompletion: false }. */
  limits?: WorkflowLimits | undefined;
  /** Absent means stored state is loaded without validation (BR-009). */
  state?: Schema<State> | undefined;
}
