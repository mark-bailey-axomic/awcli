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
 * Spread from `defaultExclude` rather than spelled out, so these are added to vitest's own patterns
 * instead of silently replacing them (which is what keeps `node_modules` and `dist` out).
 *
 * `testTimeout` is set to the same bound `verify-workspace-gate.sh` exports, and for the same reason
 * it gives: the real-git suites stand up temp repositories and run `git worktree add` in them, and
 * vitest's 5s default is a cold-transform margin sized for pure-computation suites. The repo stated
 * that case in the gate and then left `npm run test` — and CI — on the default it had just argued
 * against. Measured, the margin is not tight: the slowest test in the suite is ~1.2s. So this is
 * about the two numbers agreeing rather than about headroom, and about a timeout red meaning the same
 * thing wherever the suite is run from.
 *
 * This is the third hand-maintained spelling of the first exclusion — `.git/info/exclude` and
 * `.prettierignore` are the other two, and the tracked `.gitignore` carries neither. vitest cannot
 * read `.gitignore`, so the line is not removable here; AWCLI-27 is the ticket for making one
 * tracked file the source of it, and `.prettierignore` still lacks the `.awcli` entry this config
 * adds, which AWCLI-22 covers along with the ignore line itself.
 */
export default defineConfig({
  test: {
    exclude: [...defaultExclude, ".claude/worktrees/**", "**/.awcli/run/worktrees/**"],
    testTimeout: 30_000,
  },
});
