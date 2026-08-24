// Corpus fixture — frozen. See README.md.
//
// A workflow exactly as an author writes one: no imports, in a repository that may have no
// package.json and no node_modules (BR-032). Every name it uses is global, from awcli.d.ts.
//
// Deliberately greedy — it touches most of the surface — because a member nobody exercises
// here is a member whose standalone usability nobody has checked.

interface ReviewState {
  reviewed: string[];
  lastSubject: string | null;
}

const workflow: Workflow<ReviewState> = async (ctx) => {
  ctx.log.info("starting", { reviewed: ctx.state.reviewed.length });

  const target = ctx.args["path"] ?? ctx.project.paths.docs;
  const tests = await ctx.exec(ctx.project.commands.test);
  if (tests.exitCode !== 0) {
    ctx.log.warn("tests are red", { exitCode: tests.exitCode, stderr: tests.stderr });
  }

  const plan: Schema<{ summary: string }> = {
    check: (value) =>
      typeof value === "object" && value !== null && "summary" in value
        ? { ok: true, value: value as { summary: string } }
        : { ok: false, errors: ["expected a plan with a summary"] },
  };

  const review = await ctx.agent({
    prompt: `Review ${target} and emit a <plan> block. Home is ${ctx.env["HOME"] ?? "unset"}.`,
    output: { tag: "plan", schema: plan },
    name: "reviewer",
  });

  ctx.log.info(review.isolation.description, { commits: review.commits.length });
  ctx.state.reviewed.push(...review.commits.map((commit) => commit.sha));
  ctx.state.lastSubject = review.commits[0]?.subject ?? null;
  await ctx.state.save();

  // Feature detection rather than a crash (BR-033). supports() answers whether a member can
  // actually be called, not whether the declaration names it, so guarding a call like this is
  // the idiom that works on an awcli older than the workflow — including one whose contract
  // declares the member but has not built it yet.
  if (ctx.version.supports("sandbox")) {
    const scope = await ctx.sandbox({ name: "reviewer" });
    try {
      await scope.ctx.exec(scope.ctx.project.commands.lint);
      ctx.log.info(scope.isolation.description);
    } finally {
      await scope.dispose();
    }
  }

  const branch = await ctx.git.branch();
  if ((await ctx.git.diff()).length > 0) {
    await ctx.git.commit(`review on ${branch}`);
  }

  await ctx.fs.write("REVIEW.md", review.output.summary);
  const written = await ctx.fs.read("REVIEW.md");
  const storable = ctx.schema.storable({ written, reviewed: ctx.state.reviewed });
  if (!storable.ok) {
    ctx.log.error("not storable", { errors: storable.errors.join(", ") });
  }

  return { done: ctx.state.reviewed.length > 3 };
};

export default workflow;

export const limits: WorkflowLimits = { exhaustionIsCompletion: true };

export const state: Schema<ReviewState> = {
  check: (value) => ({ ok: true, value: value as ReviewState }),
};
