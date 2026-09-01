#!/usr/bin/env node
import { EXIT } from "./exit-codes.js";
import { processIo, runCli } from "./cli.js";

// A broken install — a manifest that is missing, unreadable or malformed — is the one
// failure that can happen before any argument is looked at. Catching it here is what
// makes the careful message in readVersion reach the operator instead of a stack trace.
try {
  process.exitCode = runCli(process.argv, processIo);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // Prefixed only when the message does not already name the program. Most faults raised inside
  // `src/runtime/` open "awcli could not ..." or "awcli cannot ...", which reads correctly on its own
  // — in a log, in a test, and beside git's own output — and unconditionally prefixing those printed
  // `awcli: awcli could not create a working copy at ...`. The prefix exists to mark a line on stderr
  // as awcli's; a line that already says so does not need it twice.
  process.stderr.write(
    message.startsWith("awcli") ? `${message}\n` : `awcli: ${message}\n`,
  );
  process.exitCode = EXIT.FAILED;
}
