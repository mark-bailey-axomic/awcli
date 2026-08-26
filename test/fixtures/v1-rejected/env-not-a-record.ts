// Rejected fixture — every line marked below MUST NOT COMPILE. See ../v1-corpus/README.md.
//
// ctx.env is an accessor and not a record, and this file is what that bought. As
// `Readonly<Record<string, string | undefined>>` it was a valid LogApi field record, so
// `ctx.log.info("env", ctx.env)` compiled and wrote every variable the operator had set into a
// durable file. Widening a log field to `unknown` would have made that easier still rather than
// harder, which is why the two changes had to arrive together. The doc comment could only ask a
// workflow not to do it; the shape is what stops it.
//
// An interface has no implicit index signature — TypeScript infers one for an object literal
// type and never for an interface — so EnvApi is not a record of anything and neither line below
// can be spelled. That is load-bearing: writing EnvApi as a type alias of an object literal type
// instead hands the index signature back and both lines compile again.
//
// The moves that still compile are here on purpose, because they are the proof that the shape
// and not a lint rule is doing the work. Spreading ctx.env or enumerating it yields its own two
// members — a pair of functions — and never a variable the operator set, so forwarding the
// result forwards nothing. There is no listing member, so there is no expression that hands the
// environment over wholesale.

const workflow: Workflow = async (ctx) => {
  ctx.log.info("env", ctx.env); // must-not-compile
  const asRecord: Readonly<Record<string, unknown>> = ctx.env; // must-not-compile

  const spread = { ...ctx.env };
  ctx.log.info("spreading it copies the API, not the environment", {
    names: Object.keys(spread).join(","),
  });

  // What it is for: one known name, asked for by name.
  const home: string | undefined = ctx.env.get("HOME");
  const set: boolean = ctx.env.has("CI");
  ctx.log.info("read one", { home, set });
  return { done: true };
};

export default workflow;
