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
  // CJS deps of BUNDLED workspace packages (e.g. @brokk/mcp → @modelcontextprotocol/sdk
  // → cross-spawn; @brokk/repomap → typescript) get inlined by esbuild, and their
  // dynamic `require(...)` of node builtins crashes in pure ESM. The standard shim:
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; import { fileURLToPath as __fileURLToPath } from 'node:url'; import { dirname as __pathDirname } from 'node:path'; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __pathDirname(__filename);" },
});
