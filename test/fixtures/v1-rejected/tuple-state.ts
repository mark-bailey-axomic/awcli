// Rejected fixture — every line marked below MUST NOT COMPILE. See ../v1-corpus/README.md.
//
// DeepReadonly used to flatten a tuple: `[string, number]` came back as
// `readonly (string | number)[]`, which is still read-only and so still refused a write — the
// half of BR-012 that must fail kept failing, and nothing noticed. What it silently gave up was
// the read: position 0 stopped being a string, and `.length` stopped being 2. The corpus fixture
// ../v1-corpus/nested-state-workflow.ts pins the reads; this file pins the writes, so a mapped
// type that preserved positions by giving up read-only-ness could not pass both.

interface Positions {
  window: [start: number, end: number];
  labelled: [name: string, ...rest: number[]];
}

const workflow: Workflow<Positions> = async (ctx) => {
  const scope = await ctx.sandbox();
  scope.ctx.state.window[0] = 1; // must-not-compile
  scope.ctx.state.window.push(2); // must-not-compile
  scope.ctx.state.labelled[0] = "renamed"; // must-not-compile
  scope.ctx.state.window = [0, 1]; // must-not-compile
  return { done: true };
};

export default workflow;
