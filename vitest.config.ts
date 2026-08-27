import { defaultExclude, defineConfig } from "vitest/config";

/**
 * Keep vitest out of the session worktrees the agent tooling nests inside the repository.
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
    exclude: [...defaultExclude, ".claude/worktrees/**"],
  },
});
