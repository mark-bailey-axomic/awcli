import { readVersion } from "./version.js";

/** Everything the CLI touches outside itself, so the core stays testable (ADR-0001). */
export interface Io {
  out(line: string): void;
  err(line: string): void;
  version(): string;
}

export const HELP = `awcli — run TypeScript agentic workflows from a global install

Usage:
  awcli --version        Print the installed version
  awcli --help           Print this message

No workflow commands exist yet. See .atelier/tickets/ for what is being built.`;

/**
 * The whole CLI as a pure function of its arguments: returns an exit code and never
 * touches the process. Run-level exit codes (finished / failed / incomplete / refused)
 * are owned by the iteration loop, not by argument handling.
 */
export function runCli(argv: readonly string[], io: Io): number {
  const args = argv.slice(2);
  const first = args[0];

  if (first === "--version" || first === "-v") {
    io.out(io.version());
    return 0;
  }

  if (first === "--help" || first === "-h") {
    io.out(HELP);
    return 0;
  }

  if (first === undefined) {
    io.err(HELP);
    return 1;
  }

  io.err(`awcli: unknown command '${first}'\n\n${HELP}`);
  return 1;
}

export const processIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  version: () => readVersion(),
};
