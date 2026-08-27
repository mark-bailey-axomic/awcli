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
import { mkdir, rm, writeFile } from "node:fs/promises";
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

// Two things on disk, because reaching the backoff takes both.
//
// A stale lock at the path, so there is a reclamation to make. That alone no longer waits on
// anything: the attempt that frees the name now takes it in the same attempt, deliberately, so that
// the ordinary post-reboot case does not sleep with the run name free. The backoff is only awaited by
// a round that ends *without* a verdict.
//
// So also a lock beside it, of the kind a reclamation elsewhere leaves for the length of a rename, a
// read and a link. The acquisition waits that out rather than refusing on it — one round spent, and
// that round is the one that awaits the timer this gate is about. The probe below makes it vanish
// after the first look, which is what the other process finishing looks like from here.
const owner = { pid: 9500, startedAt: 1_600_000_000_000 };
const elsewhere = { pid: 9600, startedAt: 1_650_000_000_000 };
const lockFile = (identity: typeof owner): string =>
  `${JSON.stringify({
    run: runName,
    owner: identity,
    acquiredAt: Date.now(),
    host: hostname(),
  })}\n`;

await writeFile(path, lockFile(owner), "utf8");
const leftover = `${path}.stale.9f1d5a52-0000-4000-8000-000000000001`;
await writeFile(leftover, lockFile(elsewhere), "utf8");

let asks = 0;
const probe: ProcessProbe = {
  self: () => Promise.resolve({ pid: process.pid, startedAt: 1_700_000_000_000 }),
  identify: async () => {
    asks += 1;
    if (asks === 1) {
      // Answered as running, and gone by the time anything looks again.
      await rm(leftover);
      return { kind: "running" as const, identity: elsewhere };
    }
    return { kind: "not-found" as const };
  },
};

const outcome = await withDisposal((stack) =>
  acquireRunLock(stack, { repositoryPath, runName, probe }),
);

if (!outcome.result.ok) {
  throw new Error(`the acquisition threw: ${String(outcome.result.error)}`);
}
const lock = outcome.result.value;
console.log(lock.ok ? "RETURNED: took the lock" : `RETURNED: refused (${lock.kind})`);
