import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const declaration = fileURLToPath(
  new URL("../../src/contract/awcli.d.ts", import.meta.url),
);
const corpusDir = fileURLToPath(new URL("../fixtures/v1-corpus", import.meta.url));
const rejectedDir = fileURLToPath(new URL("../fixtures/v1-rejected", import.meta.url));
const tsc = fileURLToPath(
  new URL("../../node_modules/typescript/bin/tsc", import.meta.url),
);

const typescriptFiles = (dir: string) =>
  readdirSync(dir)
    .filter((entry) => entry.endsWith(".ts"))
    .sort();

// Outside the repository on purpose. TypeScript resolves @types by walking up from the
// compilation root, so a directory inside this checkout would silently borrow the repo's
// node_modules and prove nothing.
const workspace = mkdtempSync(join(tmpdir(), "awcli-standalone-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

/**
 * Compile the declaration plus some workflow files in a directory with nothing installed.
 *
 * `types: []` and `typeRoots: []` are what a repository with no installed packages looks
 * like to the compiler; the equivalent command-line flags reject an empty argument (TS6044),
 * so the options go through a config file instead. `lib` is pinned to ES2022 rather than left
 * to the target's default, which would pull in the `.full` lib and put DOM in scope — the
 * declaration would then be free to name `AbortSignal` and pass here while failing in a real
 * repository that pins its lib.
 *
 * exactOptionalPropertyTypes is on because it is the strictest setting an author might have,
 * and the declaration's reason for writing every optional as `?: T | undefined` only means
 * anything under it. construction.ts passes explicit undefined for each one, so dropping a
 * `| undefined` fails here.
 */
function typecheck(
  sources: readonly string[],
  label: string,
): { status: number; output: string } {
  const dir = mkdtempSync(join(workspace, `${label}-`));
  copyFileSync(declaration, join(dir, "awcli.d.ts"));
  for (const source of sources) copyFileSync(source, join(dir, basename(source)));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        exactOptionalPropertyTypes: true,
        target: "es2022",
        lib: ["ES2022"],
        types: [],
        typeRoots: [],
      },
      files: ["awcli.d.ts", ...sources.map((source) => basename(source))],
    }),
  );

  try {
    execFileSync(process.execPath, [tsc, "--project", "tsconfig.json"], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, output: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

describe("the ambient declaration", () => {
  it("type-checks the whole v1 corpus in a directory with no installed packages", () => {
    // The repository's own typecheck runs with skipLibCheck, so nothing else in this project
    // ever looks inside awcli.d.ts. This is the test that does.
    const corpus = typescriptFiles(corpusDir).map((file) => join(corpusDir, file));
    expect(corpus.length).toBeGreaterThan(2);
    const { status, output } = typecheck(corpus, "corpus");
    expect(output).toBe("");
    expect(status).toBe(0);
  });

  it("is a script, not a module, so every name in it is global", () => {
    // One top-level import or export turns the file into a module and every declaration in
    // it stops being visible to a workflow that imports nothing (ADR-0002).
    const source = readFileSync(declaration, "utf8");
    expect(source).not.toMatch(/^(import|export)\b/m);
  });

  it("pulls in no other declaration and augments no module", () => {
    // A triple-slash reference or a module augmentation both reintroduce the dependency on
    // something being installed that ADR-0002 exists to remove.
    const source = readFileSync(declaration, "utf8");
    expect(source).not.toMatch(/\/\/\/\s*<reference/);
    expect(source).not.toMatch(/^\s*declare module\b/m);
  });
});

describe("the frozen corpus", () => {
  it("covers each v1 workflow file one at a time, so a failure names the file", () => {
    for (const file of typescriptFiles(corpusDir)) {
      const { status, output } = typecheck([join(corpusDir, file)], "one");
      expect(`${file}: ${output}`).toBe(`${file}: `);
      expect(status).toBe(0);
    }
  });
});

/** Line numbers a rejected fixture marks as having to fail, 1-based. */
function mustNotCompile(file: string): readonly number[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, index) => (line.includes("// must-not-compile") ? [index + 1] : []));
}

describe("what the declaration must refuse", () => {
  // The mirror image of the corpus. A contract that compiles everything guarantees nothing,
  // so the rules the declaration claims to make structural are checked by compiling code
  // that breaks them and requiring the failure.
  //
  // Per marked line, not per file. A shallow Readonly still refuses `state.labels = []`, so a
  // whole-file assertion would have passed while nested writes compiled happily — which is
  // exactly the hole this closes.
  for (const file of typescriptFiles(rejectedDir)) {
    it(`refuses every marked line of ${file}`, () => {
      const path = join(rejectedDir, file);
      const marked = mustNotCompile(path);
      expect(marked.length).toBeGreaterThan(0);

      const { status, output } = typecheck([path], "rejected");
      expect(status).not.toBe(0);
      for (const line of marked) {
        expect(`${file}:${line} ${output.includes(`${file}(${line},`)}`).toBe(
          `${file}:${line} true`,
        );
      }
    });
  }
});
