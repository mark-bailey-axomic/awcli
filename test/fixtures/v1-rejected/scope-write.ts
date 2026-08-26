// Rejected fixture — every line marked below MUST NOT COMPILE. See ../v1-corpus/README.md.
//
// BR-012 has no exceptions: shared state is writable from the workflow body and read-only
// everywhere inside a scope. A shallow Readonly would freeze the reference and leave the
// contents writable, so only the last of these three would fail and the rule would be
// documentation rather than structure.

interface Triage {
  counts: { open: number };
  labels: string[];
}

const workflow: Workflow<Triage> = async (ctx) => {
  const scope = await ctx.sandbox();
  scope.ctx.state.labels.push("written from a branch"); // must-not-compile
  scope.ctx.state.counts.open = 99; // must-not-compile
  scope.ctx.state.labels = []; // must-not-compile
  return { done: true };
};

export default workflow;
