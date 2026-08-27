import { defaultExclude, defineConfig } from "vitest/config";

/**
 * Keep vitest out of the working copies that get nested inside this repository.
 *
 * Two patterns, one defect, one directory apart. The second is awcli's own: this repository is where
 * awcli is built, so the first person to run awcli on awcli gets a full checkout per run and slot
 * under `.awcli/run/worktrees/`, each with its own `test/` — and vitest would collect and run every
 * one of them, against whatever branch that working copy happens to be on. It is the same failure as
 * the first pattern, waiting for the first person to dogfood the tool, so it is excluded before that
 * rather than after it.
 *
 * The same defect `.prettierignore` already documents, one tool along. A session worktree at
 * `.claude/worktrees/<session>/` is a whole second copy of this repository, complete with its own
 * `test/` directory, and vitest's default glob is repository-wide — so `npm run test` collected
 * another session's suite, ran it without the `node_modules` that copy does not have, and turned
 * `npm run check` red for anyone holding a worktree while CI stayed green on a fresh checkout that
 * has none. Git ignores the directory through `.git/info/exclude`, which vitest does not read.
 *
 * Spread from `defaultExclude` rather than spelled out, so this adds one pattern instead of
 * silently replacing vitest's own (which is what keeps `node_modules` and `dist` out).
 */
export default defineConfig({
  test: {
    exclude: [...defaultExclude, ".claude/worktrees/**", "**/.awcli/run/worktrees/**"],
  },
});
