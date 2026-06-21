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
 * BROKK_PREVIEW_TTL_MS  How far into the future to push expiresAt on each
 *                       activity bump. Default 3 600 000 ms (1 hour).
 */
const Env = z.object({
  BROKK_GATEWAY_PORT: z.coerce.number().int().positive().default(3020),
  BROKK_RUNNER_SECRET: z.string().default(""),
  BROKK_CONTROL_URL: z.string().default("http://127.0.0.1:8789"),
  BROKK_PREVIEW_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid gateway configuration:\n${issues.join("\n")}`);
  }
  return parsed.data;
}
