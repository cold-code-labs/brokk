import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // No workspace packages are imported here — pure Node built-ins + zod only.
  // Real npm dependencies stay external and are resolved from node_modules at runtime.
  noExternal: [/^@brokk\//],
});
