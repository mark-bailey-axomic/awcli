/**
 * Does taking a run lock actually return?
 *
 * This runs as its own node process, and that is the entire point. Under vitest the event loop is
 * held open by the runner, so a lock acquisition that waits on a timer nothing references still
 * completes and every test passes. In a real `awcli` process there is nothing else pending on the
 * startup path — the filesystem calls have settled, no signal handler is installed yet, stdin is
 * unreferenced — so an unreferenced timer lets node decide the loop is empty and exit. The
 * acquisition then never returns: no lock, no refusal, no error, exit 13 on an unsettled await.
 * That was real, on the ordinary BR-035 reclaim path, and the suite could not see it.
 *
 * Prints exactly one RETURNED line if the acquisition comes back, and nothing if it does not.
 * `scripts/verify-acquisition-returns.sh` runs this twice — once as written, once with the timer
 * unreferenced again — so the check is known to be capable of failing.
 *
 * Takes the repository directory as its one argument; the script that calls it owns the cleanup,
 * because a process that never returns cannot tidy up after itself.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { withDisposal } from "../../src/runtime/disposal.js";
import type { ProcessProbe } from "../../src/runtime/process-probe.js";
import { runLockPath, validateRunName } from "../../src/runtime/run-identity.js";
import { acquireRunLock } from "../../src/runtime/run-lock.js";

const repositoryPath = process.argv[2];
if (repositoryPath === undefined) {
  throw new Error("usage: acquisition-returns.js <repository-directory>");
}

const name = validateRunName("triage");
if (!name.ok) throw new Error(name.message);
const runName = name.name;

const path = runLockPath(repositoryPath, runName);
await mkdir(dirname(path), { recursive: true });

// A stale lock, so the acquisition reclaims it and goes round the loop — which is what waits on the
// backoff. A free name would be taken on the first pass and never reach it.
await writeFile(
  path,
  `${JSON.stringify({
    run: runName,
    owner: { pid: 9500, startedAt: 1_600_000_000_000 },
    acquiredAt: Date.now(),
    host: hostname(),
  })}\n`,
  "utf8",
);

const probe: ProcessProbe = {
  self: () => Promise.resolve({ pid: process.pid, startedAt: 1_700_000_000_000 }),
  identify: () => Promise.resolve({ kind: "not-found" as const }),
};

const outcome = await withDisposal((stack) =>
  acquireRunLock(stack, { repositoryPath, runName, probe }),
);

if (!outcome.result.ok) {
  throw new Error(`the acquisition threw: ${String(outcome.result.error)}`);
}
const lock = outcome.result.value;
console.log(lock.ok ? "RETURNED: took the lock" : `RETURNED: refused (${lock.kind})`);
