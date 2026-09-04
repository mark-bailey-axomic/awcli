import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

/**
 * git with none of the developer's own configuration in it, for every suite that runs real git.
 *
 * A module of its own rather than four variables per file, which is the correction run 6 asked for.
 * The pins used to live in `workspace-support.ts` — the module that also hands out `repository()` —
 * so a file that builds its own fixtures got none of them. `workspace-fs-faults.test.ts` set
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` on the environment it passed to its *own* `git()`
 * helper and left `process.env` alone, so `systemGitRunner` — which is what those tests actually
 * exercise — ran git with the developer's real `~/.gitconfig`, `core.hooksPath` and
 * `core.excludesFile`. Measured on this machine (git 2.55, macOS 26.5 on an M3 Pro): with
 * `GIT_CONFIG_GLOBAL` naming a config carrying `[core] hooksPath = <an empty directory>`, the gate's
 * own mutation `the branch awcli deletes after a failed add runs no hook either` stopped being
 * killed — `vitest run test/runtime/workspace-fs-faults.test.ts -t "runs no hook"` reported
 * `1 passed` on the mutated tree where a plain environment reported `1 failed`, and a passing suite
 * on a mutated tree aborts the whole gate run. A gate an ordinary developer setting can turn green
 * is not a gate.
 *
 * Pinned into `process.env` rather than into an environment object, because that is the only channel
 * that reaches the code under test. `gitEnvironment()` in git-process.ts strips the config
 * *injectors* by name and passes `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` through deliberately, so
 * that a caller can run git without the operator's and the machine's configuration; this is that
 * caller, and `verify-workspace-gate.sh`'s `a caller's own git configuration switch survives the
 * scrub` is the mutation that watches the pass-through these pins depend on.
 *
 * Four variables, because the two config ones do not cover the whole of a developer's git.
 * `core.excludesFile` *defaults* to `$XDG_CONFIG_HOME/git/ignore`, falling back to
 * `$HOME/.config/git/ignore`, and git reads that path whether or not the global config file has been
 * neutralised — verified on git 2.55. So a developer with `.awcli` in their personal ignore file,
 * which is an entirely plausible entry for anyone running awcli on awcli, failed "The default
 * protects my checkout": that scenario asserts `?? .awcli/` as the one new line in `git status`, and
 * on their machine there was none. A false red rather than a false pass, in the PR's headline
 * scenario. `HOME` is pinned at a scratch directory rather than at `/dev/null`, because git also
 * *writes* under `HOME` for some commands and a path it cannot use is a different kind of surprise.
 *
 * The hooks are registered at module scope on purpose, on `workspace-support.ts`'s own argument: a
 * `use…()` call each file has to remember is a call a new file will not make, and the failure is
 * silent in both directions — a suite reading the developer's configuration still passes, and the
 * gate mutation it was covering still reports `ok`. Importing this module is how a file gets
 * `gitEnvironment()`, so it cannot get an environment for git without also getting the pins.
 */
let scratchHome: string | undefined;
const inherited = new Map<string, string | undefined>();

beforeAll(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), "awcli-test-home-"));
  const pinned: Readonly<Record<string, string>> = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    HOME: scratchHome,
    XDG_CONFIG_HOME: join(scratchHome, ".config"),
  };
  for (const [name, value] of Object.entries(pinned)) {
    inherited.set(name, process.env[name]);
    process.env[name] = value;
  }
});

afterAll(async () => {
  for (const [name, value] of inherited) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  inherited.clear();
  if (scratchHome !== undefined) {
    await rm(scratchHome, { recursive: true, force: true });
    scratchHome = undefined;
  }
});

/**
 * The environment a suite's own `git()` helper runs under: the pins above, plus an identity.
 *
 * Read at call time rather than copied at import, because the pins are installed in `beforeAll` and
 * a module-level spread of `process.env` would answer a question about the moment this file was
 * imported — which is how `HOME` reached git unpinned while the docblock that moved here claimed
 * hermeticity.
 *
 * The identity is here rather than in the pins because it is not a neutralisation: a commit needs an
 * author, and a developer's own name in a fixture's history is noise rather than a hazard.
 */
export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "awcli test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "awcli test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}
