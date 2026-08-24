/**
 * The awcli context contract — the entire API a workflow author writes against.
 *
 * This file is authored, not generated: the declaration is the specification and awcli's
 * runtime is checked against it at build time (ADR-0002). awcli writes a copy of it into
 * every target repository, which is why it is a script-mode declaration with **no
 * top-level import and no top-level export** — every name below is global. A target
 * repository may be a Python or Go project with no package manifest and no installed
 * packages (BR-032), so a workflow file must type-check with zero imports, and nothing
 * here may name a Node built-in, a type package, or any dependency. A single top-level
 * import turns this into a module and every name in it vanishes from the author's editor;
 * test/contract/standalone-declaration.test.ts exists to catch exactly that.
 *
 * Additive-only within a major version (BR-033). A member may be added; none may be
 * removed or narrowed. Workflows are committed code calling this surface, and the semver
 * major is the only breaking-change signal the version range gate has (BR-003). Adding a
 * member, adding an optional property, or widening an argument type is additive. Anything
 * a previously-valid workflow would no longer compile against is not.
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
 * This type does not police state assignments. WorkflowState is State & { save }, and State
 * is deliberately unconstrained, so BR-008 is enforced at run time: awcli rejects an
 * unstorable value at the assignment that set it, naming the key. Where Storable does bite
 * at compile time is on log fields, and a workflow that wants the check early can ask for it
 * with ctx.schema.storable() rather than finding out when it assigns.
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
 * Structural on purpose. A target repository cannot install a validation library, so a
 * schema here is anything with a check method — a hand-written predicate, or a thin
 * adapter around whatever the author does happen to have.
 */
interface Schema<T = unknown> {
  check: (value: unknown) => SchemaCheck<T>;
}

/** ctx.schema — the validator awcli itself uses, exposed so a workflow can use the same one. */
interface SchemaApi {
  /**
   * The verdict awcli applies to tagged agent output (BR-020) and to stored state on load
   * (BR-009), available to the workflow so a value can be checked before an iteration is
   * spent discovering it was wrong.
   */
  check: <T>(schema: Schema<T>, value: unknown) => SchemaCheck<T>;
  /**
   * Whether a value can be written to shared state (BR-008). awcli applies this at every
   * assignment; a workflow can apply it first to decide what is worth keeping.
   */
  storable: (value: unknown) => SchemaCheck<Storable>;
}

/**
 * How isolated a call actually was, on both axes (ADR-0003).
 *
 * Reported at every agent call, because a working copy protects the repository and nothing
 * else — the filesystem outside it, the network and the credentials all stay reachable on
 * the default path, and an operator who reads "sandbox" will assume otherwise (BR-015).
 *
 * Both unions are closed, and stay closed. ADR-0003 defines exactly two values per axis, so
 * a third one is a change to the model rather than a new option, and it deserves the major
 * version that adding it would cost. Leaving them open would take exhaustiveness away from
 * every author to accommodate a case the design does not have.
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
 * which may not carry it and may change shape without notice. It degrades to unknown
 * rather than failing a run (ADR-0004, BR-026).
 */
interface Usage {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly costUsd?: number | undefined;
}

/**
 * What to ask an agent for.
 *
 * T is the type of AgentResult.output: the agent's text unless output is given, in which
 * case it is whatever that schema validates to.
 *
 * Every optional here admits undefined explicitly. awcli does not control the author's
 * compiler flags, and under exactOptionalPropertyTypes a bare `model?: string` refuses
 * `agent({ prompt, model: undefined })` — which is what building options up conditionally
 * produces. Widening is additive; narrowing back later would not be.
 */
interface AgentOptions<T = string> {
  /** The prompt, inline. */
  prompt: string;
  /** A file whose contents join the prompt — for one too long to sit in the workflow. */
  promptFile?: string | undefined;
  /** Overrides the model the repository declares as its default. */
  model?: string | undefined;
  /**
   * Ask for a tagged, validated block. The resolved prompt must actually ask the agent for
   * this tag, or the run is refused at startup rather than after all the work (BR-007). A
   * block that fails the schema costs one narrow re-ask and then the iteration — never the
   * run, because the agent's real work is already committed (BR-020).
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
 * here. A container that cannot be obtained fails the call; it is never quietly downgraded
 * to the host, because that is the one failure mode that could damage something outside the
 * repository (BR-004).
 */
interface SandboxOptions {
  /** Slot within the run. Fixes the branch, so a resumed run reattaches it (BR-036). */
  name?: string | undefined;
}

/**
 * A sandbox: a working copy of its own, plus a container to run in.
 *
 * State is read-only inside it. That is BR-012 made structural rather than documented — a
 * lost update inside a fan-out is invisible until the state is inexplicably wrong hours
 * later, so a write from a branch should not compile, let alone run. Results leave a scope
 * as return values, and the workflow body records them.
 */
interface Scope<State = Record<string, unknown>> {
  /** The context to use inside the sandbox. */
  readonly ctx: ScopedContext<State>;
  /** What was actually obtained, to state at every agent call made in here (BR-015). */
  readonly isolation: Isolation;
  /**
   * Remove the container and release the working copy. The working copy stays on disk and
   * its branch is never deleted — the commits are the deliverable (BR-021, BR-036).
   */
  dispose: () => Promise<void>;
}

/**
 * Read-only all the way down.
 *
 * A shallow Readonly freezes the reference and leaves the contents writable, so
 * `state.labels.push(x)` from inside a fan-out would still compile — and BR-012 has no
 * exceptions. State is Storable, so this only ever walks plain data; there is no Date or Map
 * for the object branch to flatten, and the function branch is there for `save`, which the
 * scoped view drops anyway.
 */
type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Element)[]
    ? readonly DeepReadonly<Element>[]
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
 * Writes are persisted as they happen rather than at the iteration boundary, so a crash
 * forty minutes in does not discard what was recorded during it (BR-023). Assignment alone
 * is already durable; save() is the explicit flush for a long iteration that wants a point
 * it knows is on disk. A value that is not Storable is rejected at the assignment that set
 * it, naming the key (BR-008).
 *
 * save is therefore the one key a declared state shape cannot use for itself.
 */
type WorkflowState<State = Record<string, unknown>> = State & {
  save: () => Promise<void>;
};

/** Commands the repository declares for itself (BR-006). */
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
 * The fixed fields are typed as present because the gate chain refuses the run at startup
 * when a workflow needs one the repository does not declare — by the time a workflow body
 * runs, a fixed field it reads is there, or the run never started. custom carries no such
 * guarantee: it is the operator's own convention, so its values stay string | undefined
 * whatever compiler flags the author happens to have on.
 *
 * If the gate chain (AWCLI-06) finds it cannot know statically which fields a workflow
 * reads, the answer is not to make these optional — that is a narrowing of a frozen surface,
 * and it would push an undefined check onto every portable workflow for a guarantee BR-006
 * already gives. Back the property with a getter that throws naming the missing field
 * instead, exactly as src/runtime/context.ts does for members that are not built yet. The
 * refusal still arrives before any side effect, and the type stays honest.
 *
 * awcli's own configuration — version range, default agent, sandbox options — is not here.
 * Those are facts about awcli rather than about the repository, and a workflow cannot act
 * on them.
 */
interface Project {
  readonly commands: ProjectCommands;
  readonly paths: ProjectPaths;
  /** Free-form, unvalidated, absent-is-normal (BR-006). */
  readonly custom: Readonly<Record<string, string | undefined>>;
}

/** ctx.git — the working copy this iteration is operating in (BR-036). */
interface GitApi {
  /** The branch the working copy is on, derived from run and slot (BR-036). */
  branch: () => Promise<string>;
  /** Commits on this branch that are not on the base it was cut from. */
  log: () => Promise<readonly Commit[]>;
  /** Unified diff of everything uncommitted. */
  diff: () => Promise<string>;
  /** Commit the working copy's current changes; refuses when there is nothing to commit. */
  commit: (message: string) => Promise<Commit>;
}

/** What a command left behind. */
interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * ctx.exec — run a command in the current working copy, on the current execution target
 * (BR-032).
 *
 * Which target that is comes from the context rather than from an argument: both axes are
 * fixed when the scope is made (ADR-0003), so there is nothing here to pass. Options can be
 * added later without breaking a caller, and none are needed yet.
 *
 * A non-zero exit is a result, not a throw. A workflow running the repository's test
 * command expects it to fail sometimes — that is why it ran it.
 */
type ExecApi = (command: string) => Promise<ExecResult>;

/**
 * ctx.fs — read and write within the working copy.
 *
 * Paths are relative to it. Reaching outside it is what ctx.exec is for: an explicit act,
 * rather than a convenience this surface offers.
 */
interface FsApi {
  read: (path: string) => Promise<string>;
  write: (path: string, contents: string) => Promise<void>;
}

/**
 * ctx.log — structured logging, already attributed to the run, iteration and agent
 * (BR-025).
 *
 * Output goes to this call's own log file and the terminal carries a summary, because four
 * parallel agents interleaved on one terminal is unreadable, and the detail is exactly what
 * is wanted afterwards (BR-028). Fields are Storable for the same reason state is: a log
 * line that cannot be serialised is a log line that is not there.
 *
 * Unlike state, a field may be undefined. Storable is what survives a round trip to disk, and
 * undefined does not — but a log line is written once and never read back, and the most
 * ordinary thing to log is a value that might be absent: spend that the agent did not report
 * (ADR-0004), an argument nobody passed. Refusing those would push a ?? "" onto every call
 * site to buy nothing.
 */
interface LogApi {
  info: (
    message: string,
    fields?: Readonly<Record<string, Storable | undefined>>,
  ) => void;
  warn: (
    message: string,
    fields?: Readonly<Record<string, Storable | undefined>>,
  ) => void;
  error: (
    message: string,
    fields?: Readonly<Record<string, Storable | undefined>>,
  ) => void;
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
   * A separate predicate for "is it declared" is an additive change if anything ever needs
   * it; what supports means is not.
   *
   * Takes a string rather than a union of the names below, on purpose: the question worth
   * asking is about a member that did not exist when the workflow was written, and a union of
   * today's names cannot express that question.
   *
   * Top-level members only. A dotted name such as "git.push" answers false, and will keep
   * answering false after git.push ships — asking about sub-API methods is a capability this
   * does not have yet. Every sub-API is unimplemented today, so the answer would be false
   * either way; teaching it dotted names later is additive.
   */
  supports: (member: string) => boolean;
}

/**
 * Everything a workflow is given. Injected, never imported (ADR-0002, BR-032).
 *
 * State is the shape of shared state. Declare it, export a matching state schema, and
 * stored state is validated on load instead of surfacing a renamed field as undefined hours
 * in (BR-009). It is left unconstrained rather than bounded by Record<string, unknown>,
 * because an interface does not satisfy that constraint and an interface is how an author
 * will write their state shape.
 *
 * Every function on this surface — here and in the sub-APIs below — is a property with an
 * arrow type rather than a method, so strictFunctionTypes applies to it. Method syntax is
 * bivariant in its parameters, which would let a runtime narrowing `commit(message: "feat")`
 * pass as a GitApi and the conformance check see nothing. Callers cannot tell the two apart.
 */
interface WorkflowContext<State = Record<string, unknown>> {
  /** Run an agent and wait for it (BR-013, BR-020, BR-022). */
  readonly agent: <T = string>(options: AgentOptions<T>) => Promise<AgentResult<T>>;
  /** Obtain a container and a working copy of its own (BR-004, BR-016). */
  readonly sandbox: (options?: SandboxOptions) => Promise<Scope<State>>;
  /** Shared state: mutable in the body, read-only inside a scope (BR-008, BR-012, BR-023). */
  readonly state: WorkflowState<State>;
  /** Whatever was passed as --arg key=value. An argument not passed is absent. */
  readonly args: Readonly<Record<string, string | undefined>>;
  /** What the repository declares about itself (BR-006). */
  readonly project: Project;
  /** The working copy this iteration is operating in (BR-036). */
  readonly git: GitApi;
  /** Run a command here (BR-032). */
  readonly exec: ExecApi;
  /** Read and write here. */
  readonly fs: FsApi;
  /** Say something, attributably (BR-025, BR-028). */
  readonly log: LogApi;
  /** The resolved environment. A variable that is not set is absent. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Validate output and state shapes (BR-008, BR-009, BR-020). */
  readonly schema: SchemaApi;
  /** Feature-detect rather than crash (BR-033). */
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
   * budget exits 2 (incomplete), not 0, so a scheduler is never told a job succeeded when
   * it was merely cut short (BR-018).
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
  default: Workflow<State>;
  /** Absent means { exhaustionIsCompletion: false }. */
  limits?: WorkflowLimits | undefined;
  /** Absent means stored state is loaded without validation (BR-009). */
  state?: Schema<State> | undefined;
}
