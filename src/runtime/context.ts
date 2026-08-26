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
 * The `satisfies` clause makes this exhaustive in both directions, and the second one is the
 * one that surprises people. Adding a member to CONTEXT_SURFACE fails to compile here until
 * someone says who builds it.
 *
 * When a member is implemented, update this table and the corresponding stubs in createContext
 * together so supports() and NotYetImplementedError stay aligned; do not loosen the types here.
 *
 * What it does not check is that a value names anything: every key carries a string, so a
 * placeholder like "unassigned" compiles. not-implemented.test.ts is what rejects one.
 */
const DELIVERED_BY = {
  agent: "AWCLI-02",
  sandbox: "AWCLI-19",
  state: "AWCLI-09",
  args: "AWCLI-20",
  project: "AWCLI-06",
  git: "AWCLI-13",
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
 * being invoked.
 */
export function createContext<State = Record<string, unknown>>(
  environment: ContextEnvironment = runningEnvironment(),
): {
  readonly agent: <T = string>(options: AgentOptions<T>) => Promise<AgentResult<T>>;
  readonly sandbox: (options?: SandboxOptions) => Promise<Scope<State>>;
  readonly state: State & { save: () => Promise<void> };
  readonly args: Readonly<Record<string, string | undefined>>;
  readonly project: Project;
  readonly git: {
    readonly dir: string;
    branch: () => Promise<string>;
    head: () => Promise<string>;
    dirty: () => Promise<boolean>;
    log: () => Promise<readonly Commit[]>;
    diff: () => Promise<string>;
    commit: (message: string) => Promise<Commit>;
  };
  readonly exec: (
    command: string | readonly string[],
    options?: ExecOptions,
  ) => Promise<ExecResult>;
  readonly fs: {
    read: (path: string) => Promise<string>;
    write: (path: string, contents: string) => Promise<void>;
  };
  readonly log: {
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
  };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly schema: { storable: (value: unknown) => SchemaCheck<Storable> };
  readonly version: {
    readonly contract: string;
    readonly awcli: string;
    supports: (member: string) => boolean;
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

  return {
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
    git: {
      get dir() {
        return sync("git", "dir");
      },
      branch: () => async("git", "branch"),
      head: () => async("git", "head"),
      dirty: () => async("git", "dirty"),
      log: () => async("git", "log"),
      diff: () => async("git", "diff"),
      commit: () => async("git", "commit"),
    },
    exec: () => async("exec"),
    fs: {
      read: () => async("fs", "read"),
      write: () => async("fs", "write"),
    },
    log: {
      info: () => sync("log", "info"),
      warn: () => sync("log", "warn"),
      error: () => sync("log", "error"),
    },
    get env() {
      return sync("env");
    },
    schema: {
      storable: () => sync("schema", "storable"),
    },
    version: {
      contract: environment.contract,
      awcli: environment.awcli,
      // Answers "can this be called", not "is this declared" — see ContractVersion.supports.
      // A workflow written against a later contract asks about a member this binary has never
      // heard of and gets false; one written against this contract asks about a member that is
      // declared but unbuilt and gets false too, which is the only answer it can act on.
      supports: (member) => environment.implemented.includes(member),
    },
  };
}

/** The runtime's shape, for conformance.ts to hold against the declaration. */
export type RuntimeContext = ReturnType<typeof createContext>;

/** The same, for a workflow that declared its own state shape — see conformance.ts. */
export type RuntimeContextFor<State> = ReturnType<typeof createContext<State>>;
