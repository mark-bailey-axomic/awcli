import { describe, expect, it } from "vitest";
import { HELP, runCli, type Io } from "../src/cli.js";
import { EXIT } from "../src/exit-codes.js";
import { readVersion } from "../src/version.js";

function recorder(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => void stdout.push(line),
    err: (line) => void stderr.push(line),
    version: () => "9.9.9",
  };
}

const argv = (...args: string[]) => ["node", "awcli", ...args];

describe("runCli", () => {
  it("reports the version and finishes", () => {
    const io = recorder();
    expect(runCli(argv("--version"), io)).toBe(EXIT.FINISHED);
    expect(io.stdout).toEqual(["9.9.9"]);
    expect(io.stderr).toEqual([]);
  });

  it("prints help to stdout and finishes when help is asked for", () => {
    const io = recorder();
    expect(runCli(argv("--help"), io)).toBe(EXIT.FINISHED);
    expect(io.stdout).toEqual([HELP]);
  });

  it("refuses with no arguments, printing help to stderr", () => {
    const io = recorder();
    expect(runCli(argv(), io)).toBe(EXIT.REFUSED);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual([HELP]);
  });

  it("names the unknown command rather than failing silently", () => {
    const io = recorder();
    expect(runCli(argv("frobnicate"), io)).toBe(EXIT.REFUSED);
    expect(io.stderr[0]).toContain("unknown command 'frobnicate'");
  });

  it("refuses rather than failing, so a usage error is never read as a broken run", () => {
    // BR-018 reserves exit 1 for "every iteration failed". A mistyped command must not
    // be indistinguishable from that; this is the precedent the gate chain inherits.
    for (const bad of [argv(), argv("frobnicate"), argv("-v"), argv("--verbose")]) {
      expect(runCli(bad, recorder())).toBe(EXIT.REFUSED);
      expect(runCli(bad, recorder())).not.toBe(EXIT.FAILED);
    }
  });

  it("leaves -v unclaimed so --verbose can have it later", () => {
    const io = recorder();
    expect(runCli(argv("-v"), io)).toBe(EXIT.REFUSED);
    expect(io.stdout).toEqual([]);
  });

  it("does not treat a flag appearing after a command as the command", () => {
    const io = recorder();
    expect(runCli(argv("frobnicate", "--version"), io)).toBe(EXIT.REFUSED);
    expect(io.stdout).toEqual([]);
  });
});

describe("readVersion", () => {
  it("reads the version from the manifest one level above the module", () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("refuses a manifest with no version rather than reporting undefined", () => {
    // The fixture module sits one level below a manifest that has no version field,
    // mirroring how dist/main.js sits below the installed package manifest.
    const fixture = new URL("./fixtures/broken/lib/x.js", import.meta.url).href;
    expect(() => readVersion(fixture)).toThrow(/no version/);
  });

  it("reports a real filesystem path, not a percent-encoded URL", () => {
    const fixture = new URL("./fixtures/broken lib/lib/x.js", import.meta.url).href;
    expect(() => readVersion(fixture)).toThrow(/broken lib/);
    expect(() => readVersion(fixture)).not.toThrow(/%20/);
  });
});
