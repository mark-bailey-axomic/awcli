import { readFileSync } from "node:fs";

/**
 * The installed version, read from the package manifest at run time.
 *
 * Resolved relative to this module rather than to the working directory, because the
 * command is invoked from the operator's repository, never from its own install
 * directory. One level up lands on the manifest both from `src/` in development and
 * from `dist/` in a global install, so no build-time injection is needed.
 */
export function readVersion(moduleUrl: string = import.meta.url): string {
  const manifestUrl = new URL("../package.json", moduleUrl);
  const raw = readFileSync(manifestUrl, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string"
  ) {
    throw new Error(`Malformed package manifest at ${manifestUrl.pathname}: no version`);
  }
  return parsed.version;
}
