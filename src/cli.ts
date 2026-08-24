import { EXIT, type ExitCode } from "./exit-codes.js";
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

No workflow commands exist yet.
Docs and issues: https://github.com/mark-bailey-axomic/awcli`;

/**
 * The whole CLI as a pure function of its arguments: returns an exit code and never
 * touches the process.
 *
 * A usage error exits `REFUSED` rather than `FAILED`, because nothing ran and nothing
 * changed. The gate chain that owns the real refusals arrives later; this establishes
 * the code it will use.
 */
export function runCli(argv: readonly string[], io: Io): ExitCode {
  const args = argv.slice(2);
  const first = args[0];

  // No `-v` shorthand: the conventional short flag for verbosity is worth keeping free,
  // and claiming it for version now would make adding --verbose a breaking change.
  if (first === "--version") {
    io.out(io.version());
    return EXIT.FINISHED;
  }

  if (first === "--help" || first === "-h") {
    io.out(HELP);
    return EXIT.FINISHED;
  }

  if (first === undefined) {
    io.err(HELP);
    return EXIT.REFUSED;
  }

  io.err(`awcli: unknown command '${first}'\n\n${HELP}`);
  return EXIT.REFUSED;
}

export const processIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  version: () => readVersion(),
};
