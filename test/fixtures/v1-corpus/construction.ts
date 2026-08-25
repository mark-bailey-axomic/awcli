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

const logApi: LogApi = {
  info: (_message: string, _fields?: Readonly<Record<string, Storable | undefined>>) => undefined,
  warn: (_message: string, _fields?: Readonly<Record<string, Storable | undefined>>) => undefined,
  error: (_message: string, _fields?: Readonly<Record<string, Storable | undefined>>) => undefined,
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
  env: { HOME: "/home/someone", UNSET: undefined },
  schema: schemaApi,
  version,
};

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
