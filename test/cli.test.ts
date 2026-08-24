import { describe, expect, it } from "vitest";
import { HELP, runCli, type Io } from "../src/cli.js";
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
  it("reports the version and exits zero", () => {
    const io = recorder();
    expect(runCli(argv("--version"), io)).toBe(0);
    expect(io.stdout).toEqual(["9.9.9"]);
    expect(io.stderr).toEqual([]);
  });

  it("accepts the short version flag", () => {
    const io = recorder();
    expect(runCli(argv("-v"), io)).toBe(0);
    expect(io.stdout).toEqual(["9.9.9"]);
  });

  it("prints help to stdout and exits zero when help is asked for", () => {
    const io = recorder();
    expect(runCli(argv("--help"), io)).toBe(0);
    expect(io.stdout).toEqual([HELP]);
  });

  it("prints help to stderr and exits non-zero when given nothing", () => {
    const io = recorder();
    expect(runCli(argv(), io)).toBe(1);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual([HELP]);
  });

  it("names the unknown command rather than failing silently", () => {
    const io = recorder();
    expect(runCli(argv("frobnicate"), io)).toBe(1);
    expect(io.stderr[0]).toContain("unknown command 'frobnicate'");
  });

  it("never touches the process", () => {
    const before = process.exitCode;
    runCli(argv("--version"), recorder());
    expect(process.exitCode).toBe(before);
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
});
