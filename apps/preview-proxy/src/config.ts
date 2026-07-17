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
 * BROKK_PREVIEW_HOST    Host the gateway proxies preview traffic to. Previews are
 *                       child processes of the runner (forge), binding 0.0.0.0 on
 *                       their port. Default "127.0.0.1" (host networking — runner
 *                       and gateway share the host loopback). On bridge networking,
 *                       set to the runner's container name (e.g. "forge") so the
 *                       gateway reaches the previews over the shared Docker network.
 * BROKK_PREVIEW_HOST_MAP  Optional per-control-plane override of the preview host,
 *                       as a comma-separated list of `<control-host>=<preview-host>`
 *                       pairs (control-host = the hostname of that plane's
 *                       BROKK_CONTROL_URL). The singleton gateway serves planes whose
 *                       previews live on DIFFERENT hosts — e.g. prod previews inside
 *                       the `forge` container (BROKK_PREVIEW_HOST=forge) while the
 *                       dev-lane runner is host-networked, so its previews are on the
 *                       host: `10.10.0.2=host.docker.internal`. A plane with no entry
 *                       falls back to BROKK_PREVIEW_HOST.
 */
const Env = z.object({
  BROKK_GATEWAY_PORT: z.coerce.number().int().positive().default(3020),
  BROKK_RUNNER_SECRET: z.string().default(""),
  BROKK_CONTROL_URL: z.string().default("http://127.0.0.1:8789"),
  BROKK_CONTROL_URL_EXTRA: z.string().default(""),
  BROKK_PREVIEW_HOST: z.string().default("127.0.0.1"),
  BROKK_PREVIEW_HOST_MAP: z.string().default(""),
  /** HMAC key for preview access keys — must match BROKK_PREVIEW_KEY on the web,
   *  which mints them. UNSET = CLOSED: every request 403s, same posture as the
   *  rest of the fleet (cf. Heimdall's authedAgent). Fail-open was considered and
   *  rejected — a gate that silently disappears when someone clears an env is
   *  worse than no gate, because everyone believes it is there. */
  BROKK_PREVIEW_KEY: z.string().default(""),
});

export type Config = z.infer<typeof Env> & {
  /** All control planes to resolve previews from, primary first (deduped). */
  controlUrls: string[];
  /** The preview host to dial for a given control-plane hostname. Falls back to
   *  BROKK_PREVIEW_HOST when the plane has no explicit entry. */
  previewHostFor: (controlHostname: string) => string;
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

  // Parse the `<control-host>=<preview-host>` pairs into a lookup. A key may be
  // given as a bare hostname or a full URL (we normalize to the hostname).
  const previewHosts = new Map<string, string>();
  for (const pair of parsed.data.BROKK_PREVIEW_HOST_MAP.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const rawKey = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (!val) continue;
    let key = rawKey;
    try {
      if (rawKey.includes("://")) key = new URL(rawKey).hostname;
    } catch {
      /* keep the raw key */
    }
    previewHosts.set(key, val);
  }

  return {
    ...parsed.data,
    controlUrls,
    previewHostFor: (controlHostname: string) =>
      previewHosts.get(controlHostname) ?? parsed.data.BROKK_PREVIEW_HOST,
  };
}
