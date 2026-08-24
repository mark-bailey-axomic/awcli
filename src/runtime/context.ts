import { CONTEXT_SURFACE, type ContextMember } from "../contract/surface.js";
import { CONTRACT_VERSION } from "../contract/version.js";
import { readVersion } from "../version.js";
import { NotYetImplementedError } from "./not-implemented.js";

/**
 * Which ticket delivers each declared-but-unbuilt member, so a refusal can say so.
 *
 * Typed against the surface rather than loosely, which makes it exhaustive: adding a member
 * to CONTEXT_SURFACE fails to compile here until someone says who builds it. `version` is
 * absent because it is built — it is the member that lets a workflow avoid the others.
 *
 * This is also the source of truth for what ctx.version.supports() answers: a member is
 * supported exactly when it is not in here.
 */
const DELIVERED_BY = {
  agent: "AWCLI-02",
  sandbox: "AWCLI-19",
  state: "AWCLI-09",
  args: "AWCLI-20",
  project: "AWCLI-06",
  git: "AWCLI-13",
  exec: "AWCLI-19",
  fs: "AWCLI-13",
  log: "AWCLI-21",
  env: "AWCLI-19",
  schema: "AWCLI-09",
} as const satisfies Record<Exclude<ContextMember, "version">, string>;

/** The members a workflow can actually call on this build. */
const IMPLEMENTED_MEMBERS: readonly string[] = CONTEXT_SURFACE.filter(
  (member) => !(member in DELIVERED_BY),
);

function refusal(
  member: keyof typeof DELIVERED_BY,
  method?: string,
): NotYetImplementedError {
  return new NotYetImplementedError(
    method === undefined ? member : `${member}.${method}`,
    DELIVERED_BY[member],
  );
}

/** Refuse a member that answers synchronously. Never returns. */
function unbuilt(member: keyof typeof DELIVERED_BY, method?: string): never {
  throw refusal(member, method);
}

/**
 * Refuse a member declared to return a promise.
 *
 * Rejecting rather than throwing, because the declared type is what callers write against:
 * `.catch()` and `Promise.all([ctx.agent(a), ctx.agent(b)])` — the fan-out BR-013 exists for
 * — handle a rejection and do not handle a synchronous throw. A stub that fails through a
 * different channel from the member that replaces it is a stub that teaches the wrong shape.
 */
function unbuiltAsync(
  member: keyof typeof DELIVERED_BY,
  method?: string,
): Promise<never> {
  return Promise.reject(refusal(member, method));
}

/**
 * Everything the context factory reads from outside itself, so the surface stays testable
 * without a real run (ADR-0001) — the same shape of seam as Io in cli.ts.
 *
 * `implemented` is separate from the contract version because they answer different
 * questions: the version says which contract this is, `implemented` says which of its
 * members this build can actually run. A test for BR-033 needs to move them independently.
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

/**
 * The context handed to a workflow.
 *
 * The return type is written out rather than annotated as WorkflowContext, and that is the
 * point: annotating it would make conformance.ts compare the declaration against itself and
 * pass forever. Two independent statements of one shape is the cost ADR-0002 accepts in
 * exchange for a declaration that leads the implementation instead of following it.
 *
 * Every member carrying a function is restated structurally, down to the sub-APIs. Naming
 * the declared interface instead — `git: GitApi` — would make the conformance check
 * tautological for that member and leave nothing for the gate script to perturb. Pure data
 * is named, because a value has no signature to drift and the object below cannot produce a
 * shape other than the one annotated.
 *
 * Every member except version refuses. Reaching one is safe — a workflow may hold a
 * reference to ctx.git and never call it — but calling it refuses by name, asynchronously
 * where the declared type is a promise and synchronously where it is not.
 */
export function createContext(environment: ContextEnvironment = runningEnvironment()): {
  agent: <T = string>(options: AgentOptions<T>) => Promise<AgentResult<T>>;
  sandbox: (options?: SandboxOptions) => Promise<Scope>;
  state: Record<string, unknown> & { save: () => Promise<void> };
  args: Readonly<Record<string, string | undefined>>;
  project: Project;
  git: {
    branch: () => Promise<string>;
    log: () => Promise<readonly Commit[]>;
    diff: () => Promise<string>;
    commit: (message: string) => Promise<Commit>;
  };
  exec: (command: string) => Promise<ExecResult>;
  fs: {
    read: (path: string) => Promise<string>;
    write: (path: string, contents: string) => Promise<void>;
  };
  log: {
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
  env: Readonly<Record<string, string | undefined>>;
  schema: {
    check: <T>(schema: Schema<T>, value: unknown) => SchemaCheck<T>;
    storable: (value: unknown) => SchemaCheck<Storable>;
  };
  version: { contract: string; awcli: string; supports: (member: string) => boolean };
} {
  return {
    agent: () => unbuiltAsync("agent"),
    sandbox: () => unbuiltAsync("sandbox"),
    get state() {
      return unbuilt("state");
    },
    get args() {
      return unbuilt("args");
    },
    get project() {
      return unbuilt("project");
    },
    git: {
      branch: () => unbuiltAsync("git", "branch"),
      log: () => unbuiltAsync("git", "log"),
      diff: () => unbuiltAsync("git", "diff"),
      commit: () => unbuiltAsync("git", "commit"),
    },
    exec: () => unbuiltAsync("exec"),
    fs: {
      read: () => unbuiltAsync("fs", "read"),
      write: () => unbuiltAsync("fs", "write"),
    },
    log: {
      info: () => unbuilt("log", "info"),
      warn: () => unbuilt("log", "warn"),
      error: () => unbuilt("log", "error"),
    },
    get env() {
      return unbuilt("env");
    },
    schema: {
      check: () => unbuilt("schema", "check"),
      storable: () => unbuilt("schema", "storable"),
    },
    version: {
      contract: environment.contract,
      awcli: environment.awcli,
      // Answers "can this be called", not "is this declared" — see ContractVersion.supports.
      // A workflow written against a later contract asks about a member this binary has
      // never heard of and gets false; one written against this contract asks about a member
      // that is declared but unbuilt and gets false too, which is the only answer it can act
      // on.
      supports: (member) => environment.implemented.includes(member),
    },
  };
}

/** The runtime's shape, for conformance.ts to hold against the declaration. */
export type RuntimeContext = ReturnType<typeof createContext>;
