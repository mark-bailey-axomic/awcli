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
 * against.
 *
 * And it is about headroom as well as agreement, which is the opposite of what this said. The claim
 * was that "the slowest test in the suite is ~1.2s", so the 5s default had room to spare and the 30s
 * value was only there to match the gate — a reading that invites the next maintainer to delete it.
 * Measured with `--reporter=verbose` over the full parallel suite, the top of the distribution is
 * 3.0-3.3s, and review recorded 7.4s on a busier machine; run alone the same test takes ~2.9s. So
 * the slowest tests sit within a factor of two of the 5s default on an idle machine and past it on a
 * loaded one, which is a suite that goes red on CI load rather than on a defect. The bound has to be
 * generous *and* the same as the gate's, so that a timeout red means the same thing wherever the
 * suite is run from.
 *
 * `hookTimeout` is set to the same bound, and it is the one that was left on vitest's 10s default
 * while the argument above was being made about the tests. The real filesystem work happens in a
 * *hook*: `workspace-support.ts`'s `afterEach` removes every temp repository a test made, each one a
 * git repository plus a checked-out worktree, and `git-hermetic.ts`'s `afterAll` removes the scratch
 * `HOME` — one hook each, in the two files the split put them in. The gate
 * is the slowest context that teardown ever runs in — ten vitest workers contending, once per
 * mutation — and the two bounds differed by 3x there in the direction of the hook. A hook timeout
 * under the gate fails the mutation for a reason that says nothing about the criterion, which is the
 * exact failure the line above was raised to prevent. `mutation-gate.sh` passes `--hookTimeout`
 * beside `--testTimeout` for the same reason; it passed only the latter.
 *
 * This is the third hand-maintained spelling of the first exclusion — `.git/info/exclude` and
 * `.prettierignore` are the other two, and the tracked `.gitignore` carries neither. vitest cannot
 * read `.gitignore`, so the line is not removable here; AWCLI-27 is the ticket for making one
 * tracked file the source of it. `.prettierignore` carries the `.awcli` entry this config adds as of
 * this PR, which leaves `.git/info/exclude` as the one spelling without it — deliberately, because
 * the suite asserts that a provisioning still shows as `?? .awcli/` until AWCLI-22 generates the
 * ignore line.
 */
export default defineConfig({
  test: {
    exclude: [...defaultExclude, ".claude/worktrees/**", "**/.awcli/run/worktrees/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
