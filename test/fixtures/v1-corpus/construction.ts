// Corpus fixture — frozen. See README.md.
//
// Construction position. Every other fixture READS the contract, and a reader cannot notice a
// field that disappeared unless it happened to touch it, nor a field narrowed in an output
// position at all — narrowing ExecResult.exitCode to 0 | 1 is invisible to `const n: number =
// result.exitCode`, because 0 | 1 is assignable to number.
//
// This file builds each declared shape as a fresh object literal instead. Deleting a field
// makes the literal an excess property; narrowing one makes the value below no longer fit. The
// values are chosen to sit outside any plausible narrowing — exitCode is 42, not 0 — so that
// the check is about the declared type rather than about the example.

interface Plan {
  summary: string;
}

interface CorpusState {
  items: string[];
  nested: { count: number };
}

const plan: Schema<Plan> = {
  check: (value) =>
    typeof value === "object" && value !== null && "summary" in value
      ? { ok: true, value: value as Plan }
      : { ok: false, errors: ["expected a plan"] },
};

const refused: SchemaCheck<Plan> = { ok: false, errors: ["one", "two"] };
const accepted: SchemaCheck<Plan> = { ok: true, value: { summary: "s" } };

const storable: Storable = {
  nil: null,
  flag: true,
  count: 42,
  text: "t",
  list: [1, "two", false, null, { nested: [] }],
};

const commit: Commit = { sha: "0".repeat(40), subject: "a subject" };

const usage: Usage = { inputTokens: 12_345, outputTokens: 6_789, costUsd: 1.25 };

// Every optional explicitly undefined. The declaration says each admits undefined so that
// options built up conditionally compile; under exactOptionalPropertyTypes this line is the
// only thing that would notice if a `| undefined` were dropped.
const unreported: Usage = { inputTokens: undefined, outputTokens: undefined, costUsd: undefined };

const isolation: Isolation = {
  workspace: "worktree",
  target: "host",
  description: "isolation: worktree — host filesystem and network reachable",
};

// worktree x container: what sandbox() fixes, and the only cell a Scope can report. Not
// liveTree x container — ADR-0003 excludes that combination, so a frozen exemplar must not
// build one and hand it to a Scope as if it were reachable.
const containerIsolation: Isolation = {
  workspace: "worktree",
  target: "container",
  description: "isolation: container",
};

// liveTree x host: the operator asked for their own checkout on the command line (BR-014). Here
// to keep the liveTree member of the workspace union exercised in the one cell it is legal in.
const liveIsolation: Isolation = {
  workspace: "liveTree",
  target: "host",
  description: "isolation: your own checkout — uncommitted work is in scope",
};

const execResult: ExecResult = { exitCode: 42, stdout: "out", stderr: "err" };
const execOptions: ExecOptions = { timeoutSeconds: 900 };
const execOptionsUnset: ExecOptions = { timeoutSeconds: undefined };

const agentOptions: AgentOptions<Plan> = {
  prompt: "Produce a <plan> block.",
  promptFile: "prompts/review.md",
  model: "a-model",
  output: { tag: "plan", schema: plan },
  timeoutSeconds: 600,
  name: "reviewer",
};

const minimalAgentOptions: AgentOptions = { prompt: "Just text back, please." };

const conditionalAgentOptions: AgentOptions = {
  prompt: "p",
  promptFile: undefined,
  model: undefined,
  output: undefined,
  timeoutSeconds: undefined,
  name: undefined,
};

const agentResult: AgentResult<Plan> = {
  commits: [commit],
  output: { summary: "done" },
  isolation,
  usage,
  logPath: "/runs/r/logs/reviewer.log",
};

const textResult: AgentResult = {
  commits: [],
  output: "plain text",
  isolation: liveIsolation,
  usage: undefined,
  logPath: "/runs/r/logs/a.log",
};

const sandboxOptions: SandboxOptions = { name: "slot-1" };
const anonymousSandbox: SandboxOptions = { name: undefined };

const commands: ProjectCommands = { test: "npm test", build: "npm run build", lint: "npm run lint" };
const paths: ProjectPaths = { docs: "docs", standards: "docs/standards" };
const project: Project = { commands, paths, custom: { tracker: "JIRA", absent: undefined } };

const gitApi: GitApi = {
  dir: "/tmp/wt",
  branch: () => Promise.resolve("awcli/run/slot"),
  head: () => Promise.resolve("0".repeat(40)),
  dirty: () => Promise.resolve(false),
  log: () => Promise.resolve([commit]),
  diff: () => Promise.resolve("diff --git a b"),
  commit: (message: string) => Promise.resolve({ sha: "1".repeat(40), subject: message }),
};

const fsApi: FsApi = {
  read: (path: string) => Promise.resolve(path),
  write: (_path: string, _contents: string) => Promise.resolve(),
};

// Fields are `unknown`, not Storable. The three calls below the literal are the half of that
// change worth pinning: an ExecResult, a Commit and the args record are the values a workflow
// most wants in a log line, and every one of them was refused while the field record was
// `Record<string, Storable | undefined>` — an interface has no implicit index signature.
const logApi: LogApi = {
  info: (_message: string, _fields?: Readonly<Record<string, unknown>>) => undefined,
  warn: (_message: string, _fields?: Readonly<Record<string, unknown>>) => undefined,
  error: (_message: string, _fields?: Readonly<Record<string, unknown>>) => undefined,
};

const envApi: EnvApi = {
  get: (name: string) => (name === "HOME" ? "/home/someone" : undefined),
  has: (name: string) => name === "HOME",
};

const schemaApi: SchemaApi = {
  storable: (value: unknown) => ({ ok: true, value: value as Storable }),
};

const version: ContractVersion = {
  contract: "1.0.0",
  awcli: "0.1.0",
  supports: (member: string) => member === "version",
};

const execApi: ExecApi = (_command: string | readonly string[], _options?: ExecOptions) =>
  Promise.resolve(execResult);

// The whole context, built by hand. This is what catches a top-level member being deleted or
// retyped, from the side a runtime has to satisfy rather than the side a workflow reads.
const context: WorkflowContext<CorpusState> = {
  agent: <T = string>(_options: AgentOptions<T>): Promise<AgentResult<T>> =>
    Promise.reject(new Error("fixture")),
  sandbox: (_options?: SandboxOptions): Promise<Scope<CorpusState>> =>
    Promise.reject(new Error("fixture")),
  state: {
    items: [],
    nested: { count: 0 },
    save: () => Promise.resolve(),
  },
  args: { key: "value", missing: undefined },
  project,
  git: gitApi,
  exec: execApi,
  fs: fsApi,
  log: logApi,
  env: envApi,
  schema: schemaApi,
  version,
};

// What a log field record now accepts, and it is the contract's own return types. Each of these
// three was a compile error under `Record<string, Storable | undefined>`, for the same reason:
// TypeScript infers an implicit index signature for an object literal type and never for an
// interface, so ExecResult and Commit are not records of Storable however they are spelled.
context.log.info("a command ran", { result: execResult, head: commit });
context.log.warn("with the arguments it was given", { args: context.args });
context.log.error("and a value that is simply absent", { spend: textResult.usage?.costUsd });

const scopedContext: ScopedContext<CorpusState> = {
  ...context,
  state: { items: [], nested: { count: 0 } },
};

const scope: Scope<CorpusState> = {
  ctx: scopedContext,
  isolation: containerIsolation,
  dispose: () => Promise.resolve(),
};

const workflowResult: WorkflowResult = { done: true };
const openEndedResult: WorkflowResult = { done: undefined };
const limits: WorkflowLimits = { exhaustionIsCompletion: true };

const workflow: Workflow<CorpusState> = async (ctx) => {
  await ctx.state.save();
  return workflowResult;
};

const asModule: WorkflowModule<CorpusState> = {
  default: workflow,
  limits,
  state: { check: (value) => ({ ok: true, value: value as CorpusState }) },
};

const bareModule: WorkflowModule = {
  default: async () => undefined,
  limits: undefined,
  state: undefined,
};

// The one class of deletion no object literal above can notice: the last field of a one-field
// shape. Excess-property checking needs the target to have properties at all — `const x: {} = {
// a: 1 }` is legal — so deleting `done` from WorkflowResult leaves `{}` and the literal still
// compiles. A `keyof` witness fails instead, because `keyof {}` is `never` and no string is
// assignable to it. An exhaustive field-by-field deletion of the declaration found six one-field
// shapes and no other hole; four of the six were invisible everywhere, and Schema and SchemaApi
// were caught only incidentally, by a reader fixture that happens to call the method — which is
// the fragility this file exists to remove.
//
// Exhaustive in that one direction, and silent about the other. Every fixture in this directory
// has to compile, which makes all of them deletion probes: a declaration that grows *looser*
// breaks none of them. Widening Storable to admit a function compiles every file here, and a
// type whose only job is refusing what cannot be stored would then be refusing nothing.
// ../v1-rejected/storable.ts is where that direction is pinned, because it is the only place it
// can be — by code that must fail.
const schemaField: keyof Schema = "check";
const schemaApiField: keyof SchemaApi = "storable";
const sandboxOptionsField: keyof SandboxOptions = "name";
const execOptionsField: keyof ExecOptions = "timeoutSeconds";
const workflowResultField: keyof WorkflowResult = "done";
const workflowLimitsField: keyof WorkflowLimits = "exhaustionIsCompletion";

// SchemaCheck is a union, so keyof is the keys its branches share — the discriminant, and the
// one field the literals above cannot vouch for: drop `ok` from either branch and the other
// branch's `ok` still covers it in an excess-property check.
const schemaCheckDiscriminant: keyof SchemaCheck<Plan> = "ok";


// The other class of change no object literal above can notice: a field that stayed and turned
// optional. Excess-property checking sees a field that disappeared, and the values are chosen so
// a narrowed one no longer fits — but a literal supplying every field compiles whether or not the
// declaration still requires them.
//
// The sweep behind the witnesses below flips every required property signature in the
// declaration to optional, one at a time, and asks `npm run typecheck`. There are 65 of them: 57
// members of an interface, and 8 members of an object type written inline inside one —
// AgentOptions.output's `tag` and `schema`, `ok` and its payload in each of SchemaCheck's two
// branches, ScopedContext's restated `state`, and WorkflowState's `save`. An earlier pass
// reported itself exhaustive over "all 59 required properties" and was not: it swept top-level
// interface members only and never descended into an inline object type, so the eight nested
// ones were never flipped at all, and the number it quoted was the size of neither set.
//
// Re-run over all 65 with these witnesses removed, twelve flips go unnoticed by anything in this
// repository. Eight are top-level, and they are the eight the witnesses were written for:
// Schema.check, ProjectCommands.build, ProjectPaths.standards, Project.custom, ExecResult.stdout
// and .stderr, WorkflowLimits.exhaustionIsCompletion, and WorkflowModule.default. Each of the
// eight breaks a committed workflow, which is what BR-033 forbids — `const e: string =
// result.stderr` stops compiling the moment stderr may be absent — and conformance.ts cannot
// reach any of them, because every one lives inside an interface both the declaration and the
// runtime merely name.
//
// The other four are nested, and were among the ones the earlier sweep never reached. All four
// are closed below: AgentOptions.output's two by naming the inline type through an indexed
// access, and SchemaCheck's two by asking the question of each branch of the union separately.
// The second needed a helper of its own, because RequiredKeys collapses a union's branches
// together — `ok` turning optional in one branch is answered for by the other branch's `ok`, and
// the payload beside it inherits that blindness. With all twelve closed the sweep run against
// this tree finds nothing, which is a claim that can be re-checked rather than taken.
//
// A key drops out of RequiredKeys the moment it turns optional, because the empty object type is
// assignable to a shape whose every field is optional and to no other. Below, each shape's
// declared field set is subtracted from that, and the remainder must be nothing — so a flip fails
// quoting the field rather than the shape. The field sets are written out rather than derived from
// `keyof`, for the reason every literal above is written out: a witness generated from the
// declaration agrees with whatever the declaration now says.
//
// The same lines catch a deletion twice over, from the Keys constraint. That is redundancy, not
// coverage — the literals above are the deletion probe, and these are here for the flip.
type RequiredKeys<Shape> = {
  [Key in keyof Shape]-?: Record<never, never> extends Pick<Shape, Key> ? never : Key;
}[keyof Shape];

/** The named fields of Shape that the declaration no longer requires. */
type NotRequired<Shape, Keys extends keyof Shape> = Exclude<Keys, RequiredKeys<Shape>>;

/**
 * The same question asked of each branch of a union separately.
 *
 * NotRequired cannot be pointed at a union: `keyof` a union is what its branches share, and
 * RequiredKeys over one collapses the branches together, so a field required in one branch
 * answers for the same field turned optional in another. This distributes first and intersects
 * the field set with each branch's own keys, so a branch is asked only about the fields it has.
 */
type NotRequiredInAnyBranch<Union, Keys extends PropertyKey> = Union extends unknown
  ? Exclude<Keys & keyof Union, RequiredKeys<Union>>
  : never;

/** Fails to compile unless its argument is `never`, quoting whatever was not. */
type NoneOf<Fields extends never> = Fields;

export type CommitFieldsRequired = NoneOf<NotRequired<Commit, "sha" | "subject">>;
export type SchemaFieldsRequired = NoneOf<NotRequired<Schema, "check">>;
export type SchemaApiFieldsRequired = NoneOf<NotRequired<SchemaApi, "storable">>;
export type SchemaCheckFieldsRequired = NoneOf<
  NotRequiredInAnyBranch<SchemaCheck<Plan>, "ok" | "value" | "errors">
>;
export type IsolationFieldsRequired = NoneOf<
  NotRequired<Isolation, "workspace" | "target" | "description">
>;
export type AgentOptionsFieldsRequired = NoneOf<NotRequired<AgentOptions, "prompt">>;
// The inline object type behind AgentOptions.output, named through an indexed access so the
// witness follows the declaration rather than restating its shape. Deleting `output` outright
// fails on this line instead, which is the deletion probe doing the same job twice again.
export type AgentOutputFieldsRequired = NoneOf<
  NotRequired<NonNullable<AgentOptions<Plan>["output"]>, "tag" | "schema">
>;
export type AgentResultFieldsRequired = NoneOf<
  NotRequired<AgentResult, "commits" | "output" | "isolation" | "logPath">
>;
export type ScopeFieldsRequired = NoneOf<NotRequired<Scope, "ctx" | "isolation" | "dispose">>;
export type ProjectCommandsFieldsRequired = NoneOf<
  NotRequired<ProjectCommands, "test" | "build" | "lint">
>;
export type ProjectPathsFieldsRequired = NoneOf<NotRequired<ProjectPaths, "docs" | "standards">>;
export type ProjectFieldsRequired = NoneOf<
  NotRequired<Project, "commands" | "paths" | "custom">
>;
export type GitApiFieldsRequired = NoneOf<
  NotRequired<GitApi, "dir" | "branch" | "head" | "dirty" | "log" | "diff" | "commit">
>;
export type ExecResultFieldsRequired = NoneOf<
  NotRequired<ExecResult, "exitCode" | "stdout" | "stderr">
>;
export type FsApiFieldsRequired = NoneOf<NotRequired<FsApi, "read" | "write">>;
export type LogApiFieldsRequired = NoneOf<NotRequired<LogApi, "info" | "warn" | "error">>;
export type EnvApiFieldsRequired = NoneOf<NotRequired<EnvApi, "get" | "has">>;
export type ContractVersionFieldsRequired = NoneOf<
  NotRequired<ContractVersion, "contract" | "awcli" | "supports">
>;
export type WorkflowStateFieldsRequired = NoneOf<
  NotRequired<WorkflowState<CorpusState>, "items" | "nested" | "save">
>;
export type ScopedContextStateRequired = NoneOf<
  NotRequired<ScopedContext<CorpusState>, "state">
>;
export type WorkflowLimitsFieldsRequired = NoneOf<
  NotRequired<WorkflowLimits, "exhaustionIsCompletion">
>;
export type WorkflowModuleFieldsRequired = NoneOf<NotRequired<WorkflowModule, "default">>;
export type WorkflowContextFieldsRequired = NoneOf<
  NotRequired<
    WorkflowContext,
    | "agent"
    | "sandbox"
    | "state"
    | "args"
    | "project"
    | "git"
    | "exec"
    | "fs"
    | "log"
    | "env"
    | "schema"
    | "version"
  >
>;

// Usage, SandboxOptions, ExecOptions and WorkflowResult have no required field to witness. The
// explicit-undefined literals above pin those from the opposite direction — an optional field
// turning required.

export default workflow;

export const built = {
  refused,
  accepted,
  storable,
  usage,
  unreported,
  isolation,
  liveIsolation,
  execResult,
  execOptions,
  execOptionsUnset,
  agentOptions,
  minimalAgentOptions,
  conditionalAgentOptions,
  agentResult,
  textResult,
  sandboxOptions,
  anonymousSandbox,
  project,
  envApi,
  scope,
  openEndedResult,
  asModule,
  bareModule,
  schemaField,
  schemaApiField,
  sandboxOptionsField,
  execOptionsField,
  workflowResultField,
  workflowLimitsField,
  schemaCheckDiscriminant,
};
