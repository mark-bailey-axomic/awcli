// Corpus fixture — frozen. See README.md.
//
// The plain path: an agent asked for text rather than a tagged block, and a workflow that
// reads what came back. Touches the result fields review-workflow.ts does not — isolation on
// both axes, usage where the agent reported it, git.log — so that narrowing any of them
// fails to compile here.

interface AuditState {
  runs: number;
}

const workflow: Workflow<AuditState> = async (ctx) => {
  // No `output`, so the result's output is the agent's text.
  const audit = await ctx.agent({ prompt: "Summarise the last ten commits." });
  const summary: string = audit.output;

  // Both isolation axes are closed unions; a switch over them is exhaustive on purpose.
  const workspace: "liveTree" | "worktree" = audit.isolation.workspace;
  const target: "host" | "container" = audit.isolation.target;
  ctx.log.info(`audit ran on ${workspace} × ${target}`, { summary });

  // Usage degrades to unknown rather than failing a run (ADR-0004), so every field is
  // optional and the workflow has to cope with that.
  const cost: number | undefined = audit.usage?.costUsd;
  const inputTokens: number | undefined = audit.usage?.inputTokens;
  const outputTokens: number | undefined = audit.usage?.outputTokens;
  if (cost === undefined) {
    ctx.log.warn("spend was not measurable for this call", { inputTokens, outputTokens });
  }

  const history = await ctx.git.log();
  for (const commit of history) {
    ctx.log.info(commit.subject, { sha: commit.sha });
  }

  const ran = await ctx.exec("git status --porcelain");
  const exitCode: number = ran.exitCode;
  ctx.log.info(audit.logPath, { exitCode, stdout: ran.stdout, stderr: ran.stderr });

  ctx.state.runs += 1;
  return { done: ctx.state.runs >= 2 };
};

export default workflow;

// The module contract as a whole, named rather than only implied by the exports.
export const asModule: WorkflowModule<AuditState> = {
  default: workflow,
  limits: { exhaustionIsCompletion: false },
  state: { check: (value) => ({ ok: true, value: value as AuditState }) },
};
