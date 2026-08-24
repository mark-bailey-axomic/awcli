#!/usr/bin/env node
import { processIo, runCli } from "./cli.js";

process.exitCode = runCli(process.argv, processIo);
