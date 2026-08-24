import { defineConfig } from "tsup";

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
});
