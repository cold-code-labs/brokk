import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // Workspace packages ship as TypeScript source — bundle them in. Real npm
  // dependencies stay external and are resolved from node_modules at runtime.
  noExternal: [/^@brokk\//],
});
