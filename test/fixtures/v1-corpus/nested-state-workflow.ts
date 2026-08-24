// Corpus fixture — frozen. See README.md.
//
// A state shape with structure in it, and a scope that may only read it. The reads below are
// the half of BR-012 that must keep working; ../v1-rejected/scope-write.ts is the half that
// must keep failing.

interface Triage {
  counts: { open: number; closed: number };
  labels: string[];
  latest: { sha: string; subject: string } | null;
}

const workflow: Workflow<Triage> = async (ctx) => {
  ctx.state.counts.open += 1;
  ctx.state.labels.push("triaged");
  ctx.state.latest = { sha: "0".repeat(40), subject: "nothing yet" };
  await ctx.state.save();

  const scope = await ctx.sandbox({ name: "triage" });
  try {
    // Reading through a scope stays fully typed, all the way down.
    const open: number = scope.ctx.state.counts.open;
    const labels: readonly string[] = scope.ctx.state.labels;
    const subject: string | undefined = scope.ctx.state.latest?.subject;
    scope.ctx.log.info("read from inside the scope", { open, labels: labels.length, subject });
  } finally {
    await scope.dispose();
  }

  return { done: ctx.state.counts.open > 5 };
};

export default workflow;

export const limits: WorkflowLimits = { exhaustionIsCompletion: false };
