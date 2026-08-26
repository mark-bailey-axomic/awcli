import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where the frozen declaration goes in the published package.
 *
 * `files` in package.json is ["dist"], so anything outside dist is not in the tarball and is not
 * in a global install. The declaration is the one artifact of this package that is not code:
 * AWCLI-22's `awcli init` has to write it into a target repository, and it can only write a file
 * the install actually carries. Bundling cannot help — tsup compiles src/main.ts and an ambient
 * declaration that nothing imports is reachable from no entry point — and `dts: true` would emit
 * types *for the bundle*, which is a different artifact from this one and would not be a script
 * -mode global declaration when it arrived.
 *
 * So it is copied, verbatim. Byte-for-byte matters: this is the file an author's editor reads,
 * and a transformed copy is a second version of the contract.
 */
const CONTRACT_DECLARATION = "contract/awcli.d.ts";

function publishDeclaration(): void {
  const source = join(here, "src", CONTRACT_DECLARATION);
  const destination = join(here, "dist", CONTRACT_DECLARATION);
  // Read first: a missing or renamed source must fail the build here rather than produce a
  // package whose declaration is silently absent, which is the state this step exists to end.
  const contents = readFileSync(source, "utf8");
  if (contents.length === 0) throw new Error(`${source} is empty`);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

// A global install must carry everything it needs: the target repository may be a
// Python or Go project with no node_modules at all (ADR-0002). Bundling is not an
// optimisation here, it is the delivery mechanism.
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  clean: true,
  sourcemap: true,
  dts: false,
  onSuccess: async () => {
    publishDeclaration();
  },
});
