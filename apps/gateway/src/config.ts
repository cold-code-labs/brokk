import { z } from "zod";

/**
 * Gateway configuration, read once from the environment at boot.
 *
 * Required env vars
 * -----------------
 * BROKK_RUNNER_SECRET   Shared secret used to authenticate calls to the control
 *                       plane (/previews endpoints). Must match the value
 *                       configured on the API server.
 *
 * Optional env vars (with defaults)
 * ----------------------------------
 * BROKK_GATEWAY_PORT    Port the gateway HTTP server binds to. Default 3020.
 * BROKK_CONTROL_URL     Base URL of the Brokk control plane. Default http://127.0.0.1:8789.
 * BROKK_CONTROL_URL_EXTRA  Optional comma-separated list of ADDITIONAL control
 *                       planes to merge previews from (e.g. the dev-lane API on
 *                       :8790). The singleton gateway serves the one public
 *                       *.preview domain, so listing the dev plane here lets dev
 *                       previews resolve on the same host. Same shared secret.
 * BROKK_PREVIEW_TTL_MS  How far into the future to push expiresAt on each
 *                       activity bump. Default 3 600 000 ms (1 hour).
 * BROKK_PREVIEW_HOST    Host the gateway proxies preview traffic to. Previews are
 *                       child processes of the runner (forge), binding 0.0.0.0 on
 *                       their port. Default "127.0.0.1" (host networking — runner
 *                       and gateway share the host loopback). On bridge networking,
 *                       set to the runner's container name (e.g. "forge") so the
 *                       gateway reaches the previews over the shared Docker network.
 */
const Env = z.object({
  BROKK_GATEWAY_PORT: z.coerce.number().int().positive().default(3020),
  BROKK_RUNNER_SECRET: z.string().default(""),
  BROKK_CONTROL_URL: z.string().default("http://127.0.0.1:8789"),
  BROKK_CONTROL_URL_EXTRA: z.string().default(""),
  BROKK_PREVIEW_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  BROKK_PREVIEW_HOST: z.string().default("127.0.0.1"),
});

export type Config = z.infer<typeof Env> & {
  /** All control planes to resolve previews from, primary first (deduped). */
  controlUrls: string[];
};

export function loadConfig(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid gateway configuration:\n${issues.join("\n")}`);
  }
  const extra = parsed.data.BROKK_CONTROL_URL_EXTRA.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const controlUrls = [...new Set([parsed.data.BROKK_CONTROL_URL, ...extra])];
  return { ...parsed.data, controlUrls };
}
