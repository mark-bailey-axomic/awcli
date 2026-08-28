import { CONTEXT_SURFACE, type ContextMember } from "../contract/surface.js";
import { CONTRACT_VERSION } from "../contract/contract-version.js";
import { readVersion } from "../version.js";
import { NotYetImplementedError } from "./not-implemented.js";

/**
 * The members this awcli declares but has not built, and the unit that delivers each.
 *
 * Maintainer-facing only — the ids never reach an operator's error message (see
 * NotYetImplementedError). fs and env are the two members no unit in the work breakdown ever
 * owned; AWCLI-23 and AWCLI-24 were opened to build them. That attribution used to be weaker
 * than the rest, because the design governed neither member with a business rule or a scenario
 * and a ticket's acceptance criteria come from scenarios. BR-038 now governs fs and BR-039
 * governs env, each with scenarios behind it, so both tickets carry scenario criteria like every
 * other id here — pending the PM re-approval the amended spec now records as outstanding.
 *
 * ctx.exec had a third form of the same gap, without a dash to show it: the design's Rules column
 * cited BR-032, but every requirement naming the member lived on AWCLI-19, which is the container
 * target throughout — so the default target, a command on the host, was owned by nothing. BR-040
 * states what that target is and AWCLI-25 builds it; AWCLI-19 keeps sandbox.
 *
 * sandbox has always pointed at AWCLI-19 and still does, but that ticket used to build only the
 * container a scope runs in and not the scope itself — a member is not delivered until something
 * constructs the object it returns. AWCLI-19 now owns ctx.sandbox end to end. Nothing here needed
 * to move; the point is that an id in this table naming a real ticket is not on its own proof that
 * the ticket builds the whole member.
 *
 * schema is the fourth, and it is the one where this table and the TDD still disagree. The TDD's
 * work breakdown lists `ctx.schema` in WB-10's Contracts line, which is AWCLI-17 — extract a
 * tagged result and re-ask for it once. AWCLI-09 is what this table names, and that is the
 * defensible half of the disagreement: the only member SchemaApi declares is storable(), which
 * answers BR-008's question about shared state, and AWCLI-09 is the unit that has to answer it
 * anyway to reject an unstorable value at the assignment that set it. AWCLI-17 validates against
 * the Schema the *workflow* supplied through AgentOptions.output and never needs ctx.schema at
 * all. So the code side stays AWCLI-09 and the TDD's WB-10 Contracts line is what needs
 * correcting. Recorded rather than quietly fixed, because this comment claims to be an audit and
 * an audit that lists three discrepancies while a fourth stands is worse than one that lists
 * none.
 *
 * git is the fifth, and it is the one this table got wrong rather than merely disagreed about — twice
 * over, which is why the id here has moved twice. It named AWCLI-13, which provisions the working
 * copy and hands back a handle carrying dir, branch, head and dirty and constructs no context around
 * one: the id pointed at a unit that delivers the handle and no context member, so the member was
 * unbuilt whatever became of the ticket. That is a fact about the code and not about a lifecycle —
 * AWCLI-13's PR is in review and has not merged, which is what the manifest's in_progress status
 * says. It then named AWCLI-11, which owns the iteration loop and no part of `ctx.git` — the TDD
 * assigns the member to WB-8, and AWCLI-11 is WB-7. It names AWCLI-14 now, the other half of WB-8,
 * and that ticket has been widened to own `ctx.git` end to end: `log`, `diff` and `commit` were owned
 * by no ticket at all while three tickets carried acceptance criteria consuming them. The widening is
 * recorded where this project records such gaps — the 2026-08-28 `ctx.git` row of the
 * `## Amendments` section in `.atelier/design/agentic-workflow-cli-rules.md`, mirroring what the
 * row above it did for `ctx.sandbox` — rather than living here as a comment, which is what it was
 * and which no ticket reads.
 *
 * The `satisfies` clause makes this exhaustive in both directions, and the second one is the
 * one that surprises people. A member added to the declaration and to CONTEXT_SURFACE fails to
 * compile here until someone says who builds it: Exclude<ContextMember, "version"> gains the
 * name, and Record then requires a key this object does not have (TS2741).
 *
 * *Implementing* a member fails here too, and the sequence is worth writing out because it is
 * three steps rather than one and the middle one is the easy one to miss:
 *
 *   1. Delete the member's entry here. That leaves the same TS2741 on the clause below — the
 *      Record still requires the key that has just gone.
 *   2. Name the member in the Exclude beside "version". That is the line that actually says
 *      "this one is built now", and it is what clears the error from step 1.
 *   3. Delete its stub in createContext, which the compiler insists on rather than merely
 *      suggests: from step 1 onward keyof typeof DELIVERED_BY no longer holds the name, so
 *      every sync() and async() call passing it stops compiling (TS2345) — three of them for
 *      a member like log, one per method.
 *
 * The codes above are what TypeScript 7 reports; a failing `satisfies` under 5.x wrapped the
 * same mismatch in TS1360 instead. Read them as which check fired, not as literals to grep.
 *
 * Nothing has to be added to a list of implemented members, because there is no such list to
 * add to. IMPLEMENTED_MEMBERS filters CONTEXT_SURFACE against the keys here and UNBUILT_MEMBERS
 * is those keys, so both follow from the three steps on their own. Loosening this type to make
 * any of those three errors go away is how the exhaustiveness gets lost.
 *
 * What it does not check is that a value names anything: every key carries a string, so a
 * placeholder like "unassigned" compiles. not-implemented.test.ts is what rejects one, and
 * check 9 of scripts/verify-spec-invariants.sh is what rejects an id that names a ticket which
 * exists but sits outside the work-breakdown unit the TDD assigns the member to — the shape the
 * AWCLI-11 value above had, and the reason that value reached a commit unchallenged. What it
 * also does not check is that the declaration admits to any of this: every key here is a member
 * a workflow author will find declared and cannot call, and
 * test/contract/unbuilt-disclosure.test.ts is what holds this table and the declaration's own
 * doc comments to each other.
 */
const DELIVERED_BY = {
  agent: "AWCLI-02",
  sandbox: "AWCLI-19",
  state: "AWCLI-09",
  args: "AWCLI-20",
  project: "AWCLI-06",
  git: "AWCLI-14",
  exec: "AWCLI-25",
  fs: "AWCLI-23",
  log: "AWCLI-21",
  env: "AWCLI-24",
  schema: "AWCLI-09",
} as const satisfies Record<Exclude<ContextMember, "version">, string>;

/**
 * The members a workflow can actually call on this build — what supports() answers from.
 *
 * Object.hasOwn rather than `in`: `in` walks the prototype chain, so a future member named
 * toString or constructor would be treated as unbuilt and supports() would answer false for a
 * member that works. That is the one direction BR-033 says must never happen.
 */
const IMPLEMENTED_MEMBERS: readonly string[] = CONTEXT_SURFACE.filter(
  (member) => !Object.hasOwn(DELIVERED_BY, member),
);

/** The members this build declares and cannot run, for the disclosure test to read. */
export const UNBUILT_MEMBERS: readonly string[] = Object.keys(DELIVERED_BY);

/**
 * Everything the context factory reads from outside itself, so the surface stays testable
 * without a real run (ADR-0001) — the same shape of seam as Io in cli.ts.
 *
 * `implemented` is separate from the contract version because they answer different questions:
 * the version says which contract this is, `implemented` says which of its members this build
 * can actually run. A test for BR-033 needs to move them independently.
 */
export interface ContextEnvironment {
  readonly contract: string;
  readonly awcli: string;
  readonly implemented: readonly string[];
}

/** What a real run supplies. Read lazily, as processIo reads the version lazily. */
export function runningEnvironment(): ContextEnvironment {
  return {
    contract: CONTRACT_VERSION,
    awcli: readVersion(),
    implemented: IMPLEMENTED_MEMBERS,
  };
}

function refusal(
  environment: ContextEnvironment,
  member: keyof typeof DELIVERED_BY,
  method?: string,
): NotYetImplementedError {
  return new NotYetImplementedError(
    method === undefined ? member : `${member}.${method}`,
    DELIVERED_BY[member],
    environment.awcli,
  );
}

/**
 * The context handed to a workflow.
 *
 * The return type is written out rather than annotated as WorkflowContext, and that is the
 * point: annotating it would make conformance.ts compare the declaration against itself and
 * pass forever. Two independent statements of one shape is the cost ADR-0002 accepts in
 * exchange for a declaration that leads the implementation instead of following it.
 *
 * Restating it means restating the modifiers too. Every function the declaration marks
 * `readonly` is marked `readonly` here, at both levels, because SameReadonly is what compares
 * them and a modifier dropped from one side is exactly the drift it exists to catch.
 *
 * What that does and does not reach: each member's own signature is restated here, so a
 * parameter or return type drifting from the declaration is caught. The types those signatures
 * mention — AgentOptions, AgentResult, Scope, Project, ExecResult — are the contract's own and
 * are necessarily shared, so conformance compares member shapes and not the interiors of those
 * interfaces. Deleting or narrowing a field inside one is invisible here; the
 * construction-position fixtures in test/fixtures/v1-corpus are what catch that.
 *
 * How a member refuses depends on what the declaration says it returns. A member typed to
 * return a promise rejects; one that answers synchronously throws. A member that is data
 * refuses at the property read, which is earlier than either — so `const { state } = ctx`
 * throws at the destructure, and nothing reachable through ctx.state, including its save(),
 * can be called at all on this build. Only the members carrying functions can be held without
 * being invoked, and ctx.env became one of those when it stopped being a record: reading it is
 * safe now and get("HOME") is where it refuses.
 */
export function createContext<State = Record<string, unknown>>(
  environment: ContextEnvironment = runningEnvironment(),
): {
  readonly agent: <T = string>(options: AgentOptions<T>) => Promise<AgentResult<T>>;
  readonly sandbox: (options?: SandboxOptions) => Promise<Scope<State>>;
  readonly state: State & { readonly save: () => Promise<void> };
  readonly args: Readonly<Record<string, string | undefined>>;
  readonly project: Project;
  readonly git: {
    readonly dir: string;
    readonly branch: () => Promise<string>;
    readonly head: () => Promise<string>;
    readonly dirty: () => Promise<boolean>;
    readonly log: () => Promise<readonly Commit[]>;
    readonly diff: () => Promise<string>;
    readonly commit: (message: string) => Promise<Commit>;
  };
  readonly exec: (
    command: string | readonly string[],
    options?: ExecOptions,
  ) => Promise<ExecResult>;
  readonly fs: {
    readonly read: (path: string) => Promise<string>;
    readonly write: (path: string, contents: string) => Promise<void>;
  };
  readonly log: {
    readonly info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
    readonly warn: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
    readonly error: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  };
  readonly env: {
    readonly get: (name: string) => string | undefined;
    readonly has: (name: string) => boolean;
  };
  readonly schema: { readonly storable: (value: unknown) => SchemaCheck<Storable> };
  readonly version: {
    readonly contract: string;
    readonly awcli: string;
    readonly supports: (member: string) => boolean;
  };
} {
  /** Refuse a member that answers synchronously. Never returns. */
  const sync = (member: keyof typeof DELIVERED_BY, method?: string): never => {
    throw refusal(environment, member, method);
  };

  /**
   * Refuse a member declared to return a promise, by rejecting rather than throwing.
   *
   * The declared type is what callers write against: `.catch()` and
   * `Promise.all([ctx.agent(a), ctx.agent(b)])` — the fan-out BR-013 exists for — handle a
   * rejection and do not handle a synchronous throw. A stub that fails through a different
   * channel from the member replacing it teaches the wrong shape.
   */
  const async = (member: keyof typeof DELIVERED_BY, method?: string): Promise<never> =>
    Promise.reject(refusal(environment, member, method));

  /**
   * Freeze one object of the surface, keeping its literal type.
   *
   * The declaration marks every function `readonly`, and that is a compile-time claim about
   * code that was compiled against it. BR-025 asks for more: an assignment over log.info is to
   * be refused, and a caller that reached this context from JavaScript, or through a cast, or
   * from a workflow whose editor never loaded awcli.d.ts, has had nothing standing in its way.
   * Freezing makes that assignment throw — a workflow module is ESM and therefore strict, so a
   * write to a frozen property is a TypeError rather than a silent no-op.
   *
   * Shallow, so each sub-API is frozen in its own right on the way past: freezing the context
   * alone would stop `ctx.log = x` and leave `ctx.log.info = x`, which is the assignment BR-025
   * actually names. Object.freeze returns Readonly<T>; the annotation hands back T so that the
   * object literals below keep the types conformance.ts compares.
   */
  const frozen = <T extends object>(value: T): T => Object.freeze(value);

  return frozen({
    agent: () => async("agent"),
    sandbox: () => async("sandbox"),
    get state() {
      return sync("state");
    },
    get args() {
      return sync("args");
    },
    get project() {
      return sync("project");
    },
    git: frozen({
      get dir() {
        return sync("git", "dir");
      },
      branch: () => async("git", "branch"),
      head: () => async("git", "head"),
      dirty: () => async("git", "dirty"),
      log: () => async("git", "log"),
      diff: () => async("git", "diff"),
      commit: () => async("git", "commit"),
    }),
    exec: () => async("exec"),
    fs: frozen({
      read: () => async("fs", "read"),
      write: () => async("fs", "write"),
    }),
    log: frozen({
      info: () => sync("log", "info"),
      warn: () => sync("log", "warn"),
      error: () => sync("log", "error"),
    }),
    env: frozen({
      get: () => sync("env", "get"),
      has: () => sync("env", "has"),
    }),
    schema: frozen({
      storable: () => sync("schema", "storable"),
    }),
    version: frozen({
      contract: environment.contract,
      awcli: environment.awcli,
      // Answers "can this be called", not "is this declared" — see ContractVersion.supports.
      // A workflow written against a later contract asks about a member this binary has never
      // heard of and gets false; one written against this contract asks about a member that is
      // declared but unbuilt and gets false too, which is the only answer it can act on.
      supports: (member) => environment.implemented.includes(member),
    }),
  });
}

/** The runtime's shape, for conformance.ts to hold against the declaration. */
export type RuntimeContext = ReturnType<typeof createContext>;

/** The same, for a workflow that declared its own state shape — see conformance.ts. */
export type RuntimeContextFor<State> = ReturnType<typeof createContext<State>>;
