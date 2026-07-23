import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const here = dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  reactStrictMode: true,
  // Don't advertise the framework (CCL-02 fingerprinting finding).
  poweredByHeader: false,
  output: "standalone",
  outputFileTracingRoot: join(here, "../../"),
  // @brokk/sdk ships TypeScript source — let Next compile it on build. The
  // yggdrasil packages ship source too and must be transpiled in this app.
  transpilePackages: [
    "@brokk/sdk",
    "@brokk/core",
    "@cold-code-labs/yggdrasil-tokens",
    "@cold-code-labs/yggdrasil-brand",
    "@cold-code-labs/yggdrasil-react",
  ],
  // Next's build-time typecheck also walks transpilePackages sources. Yggdrasil
  // ships .tsx without its own @types/react resolution under pnpm+Docker, which
  // flakes Coolify images while `pnpm typecheck` (app-only) stays green. Rely on
  // CI typecheck for app correctness.
  typescript: { ignoreBuildErrors: true },
  // webpack's wasm xxhash64 (WasmHash) flakily dies with "Cannot read properties
  // of undefined (reading 'length')" under parallel load on ymir (dev + build).
  // Known webpack bug class; the JS sha256 hasher sidesteps it at negligible cost.
  webpack: (config) => {
    config.output.hashFunction = "sha256";
    return config;
  },
  // The control-plane API is proxied under /api by a runtime route handler
  // (app/api/[...path]/route.ts) — NOT a rewrite. `output: "standalone"` freezes
  // rewrite destinations at build time, which broke runtime BROKK_API_INTERNAL_URL.
};

export default nextConfig;
