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
 * and calling one fails rather than doing nothing. Ask ctx.version.supports("agent") before
 * calling a member you have not seen work; that predicate answers for this build, and it is
 * the only thing in this file that describes the present rather than the contract.
 *
 * Additive-only within a major version (BR-033). A member may be added; none may be removed
 * or narrowed. Workflows are committed code calling this surface, and the semver major is the
 * only breaking-change signal the version range gate has (BR-003). Adding a member, adding an
 * optional property, or widening an argument type is additive. Anything a previously-valid
 * workflow would no longer compile against is not.
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
 * unstorable value at the assignment that set it, naming the key. Where Storable does bite at
 * compile time is on log fields, and a workflow that wants the check early can ask for it
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
 * Structural on purpose. A target repository cannot install a validation library, so a schema
 * here is anything with a check method — a hand-written predicate, or a thin adapter around
 * whatever the author does happen to have.
 *
 * There are no constructors for building one. That is a real gap for an author who wants
 * BR-009 state validation without a library, and it is a gap that can be closed additively;
 * freezing a combinator vocabulary now would be guessing at one.
 */
interface Schema<T = unknown> {
  check: (value: unknown) => SchemaCheck<T>;
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
  storable: (value: unknown) => SchemaCheck<Storable>;
}

/**
 * How isolated a call actually was, on both axes (ADR-0003).
 *
 * Reported at every agent call, because a working copy protects the repository and nothing
 * else — the filesystem outside it, the network and the credentials all stay reachable on the
 * default path, and an operator who reads "sandbox" will assume otherwise (BR-015).
 *
 * Nothing a workflow can pass selects the workspace axis, and that is deliberate. The live
 * checkout is opted into by the operator on the command line (`awcli run --live`), never by
 * the workflow: BR-014 requires the person whose uncommitted work is at stake to be the one
 * asking, and it keeps one workflow file portable across both modes. AWCLI-13 implements the
 * flag; it adds nothing here.
 *
 * Both unions are closed, and stay closed. ADR-0003 defines exactly two values per axis, so a
 * third is a change to the model rather than a new option, and it deserves the major version
 * that adding it would cost. Leaving them open would take exhaustiveness away from every
 * author to accommodate a case the design does not have.
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
 * goes in — ctx.env in particular is not material to paste into a prompt.
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
   * Resolved within the working copy and confined to it, on the same terms as ctx.fs.read: a
   * path escaping the working copy is refused rather than resolved. This one is the sharper
   * of the two, because its contents are transmitted off the machine by construction.
   */
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
  dispose: () => Promise<void>;
}

/**
 * Read-only all the way down.
 *
 * A shallow Readonly freezes the reference and leaves the contents writable, so
 * `state.labels.push(x)` from inside a fan-out would still compile — and BR-012 has no
 * exceptions.
 *
 * It walks whatever shape the author declared, which nothing constrains: BR-008 rejects an
 * unstorable value at run time, but a state shape declaring a Date or a Map still reaches the
 * object branch here and comes back mapped rather than intact. Declare state as plain data
 * and the two rules agree; declare a class instance and this type is the second place it
 * fails, not the first.
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
  save: () => Promise<void>;
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
  branch: () => Promise<string>;
  /** The commit the working copy is currently on. Recorded against the run (BR-025). */
  head: () => Promise<string>;
  /** Whether the working copy has uncommitted changes — what a resumed run inherited. */
  dirty: () => Promise<boolean>;
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
 * whenever any part of the command came from somewhere else, which includes the repository's
 * declared commands, an --arg value, and anything an agent produced. A string is handed to a
 * shell, because a repository's declared test command is allowed to contain && and pipes and
 * would be meaningless otherwise; a string built by interpolation is a command the interpolated
 * value can rewrite.
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
 * ctx.fs — read and write within the working copy.
 *
 * Paths are resolved against the working copy and confined to it: one that escapes, by `..`
 * or by being absolute or through a symlink, is refused rather than resolved. Reaching outside
 * deliberately is what ctx.exec is for — an explicit act, rather than something a mistyped
 * path does by accident.
 *
 * Confinement protects the operator's other files. It is not a boundary around the agent: git
 * hooks living in the working copy are executed by ctx.git.commit() and by any ctx.exec that
 * runs git, and they run with the workflow's own reach. Only a container is a boundary
 * (BR-015).
 */
interface FsApi {
  read: (path: string) => Promise<string>;
  write: (path: string, contents: string) => Promise<void>;
}

/**
 * ctx.log — structured logging, already attributed to the run, iteration and agent (BR-025).
 *
 * Output goes to this call's own log file and the terminal carries a summary, because four
 * parallel agents interleaved on one terminal is unreadable, and the detail is exactly what is
 * wanted afterwards (BR-028). Fields are Storable for the same reason state is: a log line
 * that cannot be serialised is a log line that is not there.
 *
 * A log is durable and is read later by people and by other agents. awcli redacts values
 * matching known secret shapes from logs and run records, which is a net cast over shapes it
 * recognises rather than a guarantee about a value it does not — logging a credential on
 * purpose still writes it down. The workflow decides what is worth recording.
 *
 * Unlike state, a field may be undefined. Storable is what survives a round trip to disk, and
 * undefined does not — but a log line is written once and never read back, and the most
 * ordinary thing to log is a value that might be absent: spend the agent did not report
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
  supports: (member: string) => boolean;
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
 * Every function on this surface — here and in the sub-APIs above — is a property with an
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
  /**
   * The environment the execution target resolves for this run, minus awcli's own agent
   * credentials.
   *
   * Those are lent to a container as a read-only mount for the life of the run and never
   * copied (BR-016); handing them back through this record would copy them into every prompt
   * and every run record that reads it, which is the thing BR-016 exists to prevent. What
   * remains is the operator's environment, which is theirs and may hold secrets of its own —
   * so this is somewhere to read a specific known variable from, not somewhere to enumerate
   * and forward. A variable that is not set, or that awcli removed, is absent.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The rules awcli applies that a workflow cannot reimplement (BR-008). */
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
  default: Workflow<State>;
  /** Absent means { exhaustionIsCompletion: false }. */
  limits?: WorkflowLimits | undefined;
  /** Absent means stored state is loaded without validation (BR-009). */
  state?: Schema<State> | undefined;
}
