// Corpus fixture — frozen. See README.md.
//
// The two members whose *shape* the contract states rather than merely their names, read the way
// an author reads them. Both are invisible to every other fixture here.
//
// ctx.env is an accessor: get one known name, or ask whether it is there. There is no listing
// member and no record to spread, which is the rule made structural rather than advised —
// ../v1-rejected/env-not-a-record.ts is the half that must fail.
//
// Tuple state is the other. DeepReadonly is what BR-012 applies inside a scope, and it used to
// flatten a tuple to `readonly (string | number)[]`: still read-only, so ../v1-rejected/
// scope-write.ts and tuple-state.ts kept failing exactly as before, while every position and the
// length quietly became something else. Only a reader notices that, and only one that reads a
// position rather than iterating. This is that reader.

interface Window {
  span: [start: number, end: number];
  head: [sha: string, subject: string];
  seen: string[];
}

const workflow: Workflow<Window> = async (ctx) => {
  // One known name, by name. A variable awcli removed for this run is indistinguishable from one
  // that was never set (BR-039), so `has` and an undefined `get` answer the same question.
  const home: string | undefined = ctx.env.get("HOME");
  const underCi: boolean = ctx.env.has("CI");
  ctx.log.info("environment", { home, underCi });

  // Nothing read from ctx.env goes into a prompt. A prompt leaves the machine and is written to
  // this call's log, so interpolating a variable is how a credential reaches a model provider
  // and a run record.
  if (ctx.version.supports("env") && underCi) {
    ctx.log.info("running under CI");
  }

  ctx.state.span = [0, 10];
  ctx.state.head = ["0".repeat(40), "nothing yet"];
  ctx.state.seen.push("window");
  await ctx.state.save();

  const scope = await ctx.sandbox({ name: "window" });
  try {
    // Every one of these is a position, not an element of a widened union. A DeepReadonly that
    // flattened the tuple would fail here and only here.
    const start: number = scope.ctx.state.span[0];
    const end: number = scope.ctx.state.span[1];
    const sha: string = scope.ctx.state.head[0];
    const subject: string = scope.ctx.state.head[1];
    const positions: 2 = scope.ctx.state.span.length;
    const seen: readonly string[] = scope.ctx.state.seen;
    scope.ctx.log.info(subject, { start, end, positions, sha, seen: seen.length });
  } finally {
    await scope.dispose();
  }

  return { done: ctx.state.seen.includes("window") };
};

export default workflow;

export const state: Schema<Window> = {
  check: (value) => ({ ok: true, value: value as Window }),
};
