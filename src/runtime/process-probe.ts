import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Who holds something, in a form that survives the death of the process that recorded it.
 *
 * A process id alone does not survive it. Ids are recycled — on Linux by default after 32768
 * more processes, which a busy machine reaches in minutes — so a lock recording only a pid says
 * "some process, maybe mine, maybe an unrelated editor that started this afternoon". Pairing the
 * id with the moment the OS says that process started makes the pair unique in practice: a
 * recycled id belongs to a process that started later, so the pair no longer matches and the
 * lock reads as what it is, abandoned.
 *
 * The start time comes from the operating system, never from the process itself. A process
 * reporting its own start time cannot answer for the process that used its id before it.
 */
export interface ProcessIdentity {
  readonly pid: number;
  /**
   * Milliseconds since the epoch, as the OS reports the process's start.
   *
   * Second granularity on both platforms, and that is enough: the comparison is against a value
   * recorded by an earlier process, and for it to collide the recycled id would have to land in
   * the same second as the original's start.
   */
  readonly startedAt: number;
}

/**
 * Asking the operating system who a process is.
 *
 * A port, because every liveness decision in the lock goes through it and none of them can be
 * tested against real processes: a test needs a process that is alive, one that is gone, and —
 * the case that matters most — an id belonging to a *different* process than the one recorded.
 * The third cannot be staged for real at all. So the decision logic is tested against a
 * substitute, and the adapter below is tested against real processes.
 */
export interface ProcessProbe {
  /** This process's identity, obtained the same way as any other's — see `systemProcessProbe`. */
  self(): ProcessIdentity;
  /** The identity of a live process, or nothing when no process holds that id. */
  identify(pid: number): ProcessIdentity | undefined;
}

/**
 * The lock's own view of a process id it did not record.
 *
 * `gone` and `different` are kept apart because the operator-facing explanation differs: one is
 * "the process that held this is no longer running", the other is "that id belongs to something
 * else now". Both are stale; conflating them would make the reclamation message vaguer than the
 * evidence for it.
 */
export type Liveness = "live" | "gone" | "different";

/** Whether the process recorded in `owner` is still the process running under that id. */
export function livenessOf(owner: ProcessIdentity, probe: ProcessProbe): Liveness {
  const current = probe.identify(owner.pid);
  if (current === undefined) return "gone";
  return current.startedAt === owner.startedAt ? "live" : "different";
}

/**
 * How long `ps` may take before we treat it as unavailable.
 *
 * Short on purpose. This runs on the startup path, before anything has happened, and a `ps` that
 * hangs must not be the reason a run never begins.
 */
const PS_TIMEOUT_MS = 2_000;

/**
 * Reads a process's start time from `/proc`, the way Linux exposes it.
 *
 * Field 22 of `/proc/<pid>/stat` is the start time in clock ticks since boot. Converting it to
 * wall-clock needs the boot time, which is why `/proc/stat`'s `btime` is read too — and the
 * conversion is deliberately not cached across calls, because a lock check happens once per run
 * and a stale cached boot time would be a bug that only appears after a suspend.
 *
 * Parsed from the end rather than by splitting on spaces from the start: field 2 is the
 * executable name in parentheses and may itself contain spaces and parentheses, which is the
 * classic way of misreading this file.
 */
function procStartedAt(pid: number): number | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }

  const afterName = stat.slice(stat.lastIndexOf(")") + 1).trim();
  // Fields 3 onwards. Field 22 overall is therefore index 19 here.
  const ticks = Number(afterName.split(/\s+/)[19]);
  if (!Number.isFinite(ticks)) return undefined;

  const bootMatch = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
  const bootSeconds = Number(bootMatch?.[1]);
  if (!Number.isFinite(bootSeconds)) return undefined;

  // USER_HZ, fixed at 100 on Linux for the purposes of this file regardless of the kernel's
  // internal tick rate. There is no syscall-free way to read it, and it has not been anything
  // else on a Linux target awcli supports.
  return Math.round(bootSeconds * 1000 + (ticks / 100) * 1000);
}

/**
 * Reads a process's start time from `ps`, the way macOS exposes it.
 *
 * `-o lstart=` prints an absolute local time, which `Date.parse` handles, and the empty `=`
 * suppresses the header so there is nothing to skip. `-p` on a dead id exits non-zero and prints
 * nothing, which is the answer we want and arrives as a throw.
 */
function psStartedAt(pid: number): number | undefined {
  let output: string;
  try {
    output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
  const parsed = Date.parse(output.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The real probe: asks the operating system, and answers for this process the same way.
 *
 * `self()` is `identify(process.pid)` rather than anything derived from `process.uptime()`, and
 * that is not a shortcut — it is the property the whole comparison rests on. The value written
 * into a lock and the value a later run reads back for the same process must come from the same
 * source, or a live owner's identity will fail to match its own recorded one and every lock will
 * read as stale. Deriving `self` differently is how that bug gets written; there is only one
 * source here, so it cannot be.
 */
export const systemProcessProbe: ProcessProbe = {
  self() {
    // Not `this.identify`: a caller that destructures the probe would lose `this`, and the
    // failure would be a thrown error on the startup path rather than anything obvious here.
    const identity = systemProcessProbe.identify(process.pid);
    // Unreachable in practice: a process asking about itself is running by definition. Failing
    // loudly rather than inventing a start time, because a wrong `startedAt` here would be
    // written into the lock and would make this run's own lock look stale to the next one.
    if (identity === undefined) {
      throw new Error(
        `Cannot determine this process's start time (pid ${process.pid}). awcli needs it to hold a run lock that a later run can tell apart from a recycled process id.`,
      );
    }
    return identity;
  },

  identify(pid: number): ProcessIdentity | undefined {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    const startedAt =
      process.platform === "linux" ? procStartedAt(pid) : psStartedAt(pid);
    return startedAt === undefined ? undefined : { pid, startedAt };
  },
};
