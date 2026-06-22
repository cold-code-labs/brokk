import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const here = dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  outputFileTracingRoot: join(here, "../../"),
  // @brokk/sdk ships TypeScript source — let Next compile it on build.
  transpilePackages: ["@brokk/sdk"],
  // The control-plane API is proxied under /api by a runtime route handler
  // (app/api/[...path]/route.ts) — NOT a rewrite. `output: "standalone"` freezes
  // rewrite destinations at build time, which broke runtime BROKK_API_INTERNAL_URL.
};

export default nextConfig;
