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
  process.stderr.write(`awcli: ${message}\n`);
  process.exitCode = EXIT.FAILED;
}
