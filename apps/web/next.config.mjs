/** @type {import('next').NextConfig} */
const API = process.env.BROKK_API_INTERNAL_URL ?? "http://127.0.0.1:8789";

const nextConfig = {
  reactStrictMode: true,
  // Proxy the control-plane API under /api so the browser talks to one origin
  // (no CORS, single public host). SSE (/api/runs/:id/events) streams through.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API}/:path*` }];
  },
};

export default nextConfig;
