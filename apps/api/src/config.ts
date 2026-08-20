import { z } from "zod";

/** Control-plane configuration, read once from the environment at boot. The
 *  runner secret defaults to empty so the API can boot for local UI work;
 *  runner endpoints reject requests when no secret is configured. */
const Env = z.object({
  BROKK_DATABASE_URL: z.string().min(1, "BROKK_DATABASE_URL is required"),
  BROKK_API_PORT: z.coerce.number().int().positive().default(8789),

  // Shared secret the runner presents on /runner/* and /runs/:id/{events,complete}.
  BROKK_RUNNER_SECRET: z.string().default(""),

  // GitHub webhook HMAC secret (Settings → Webhooks). Empty = accept unsigned (dev only).
  BROKK_GITHUB_WEBHOOK_SECRET: z.string().default(""),

  // PAT used by the review reconciler (BROKK-45) to poll merged PRs and heal cards
  // stuck in `review` when a webhook was missed. Same token the forge/compose already
  // injects. Empty = reconciler disabled (webhook-only close).
  GITHUB_TOKEN: z.string().default(""),

  // Bearer secret guarding mutating API calls (POST/PUT/PATCH/DELETE). The web
  // proxy injects it server-side; external callers can't enqueue forge runs.
  // Empty = open (local/dev). Reads stay open; /runner & /webhooks self-auth.
  BROKK_API_SECRET: z.string().default(""),

  // Base URL of the Sindri chat runtime (worker host). Empty = /chat → 503.
  BROKK_SINDRI_URL: z.string().default(""),

  // Eitri HTTP trigger base (ADR 0069). Empty = Story open-pr skips review call.
  EITRI_URL: z.string().default(""),

  // Heimdall's SCOPED Agent API — the provisioning surface "Nova Conversa"
  // (ADR 0038) calls to birth a dev-first app and to publish/roll it back.
  // Both empty = /conversations disabled (503).
  //
  // This used to be HEIMDALL_API_URL + HEIMDALL_TOKEN, pointed straight at the
  // control plane with its INTERNAL token — which handed Brokk authority over
  // the entire fleet, Ice Vault included, just to create an app. The agent token
  // reaches only the allow-listed /api/agent/* proxies, and the lifecycle verbs
  // there are scoped to apps this agent created (Heimdall 403s the rest).
  HEIMDALL_AGENT_URL: z.string().default(""),
  HEIMDALL_AGENT_TOKEN: z.string().default(""),

  // Coder — the runtime (ADR 0100). The control plane is the ONLY Coder client:
  // humans reach a bancada through Brokk, never with a Coder account of their own.
  // Empty URL/token = no runtime wired → /bancadas answers 503 instead of guessing.
  // Hauldr control-plane base — the dev lane a bancada boots against. Empty =
  // the bancada boots on whatever env the repo already carries (passthrough).
  HAULDR_CONTROL_URL: z.string().default(""),
  CODER_URL: z.string().default(""),
  CODER_TOKEN: z.string().default(""),
  CODER_TEMPLATE: z.string().default("bancada"),
  // What a WORKSPACE calls to broker a git credential. Internal service name on
  // the shared docker network — a workspace must never need the public host.
  BROKK_INTERNAL_URL: z.string().default("http://brokk-api:8789"),
  // Stop a ready bancada that nobody has touched for this long. A dev server
  // running unattended is someone's bill.
  BANCADA_IDLE_MS: z.coerce.number().int().positive().default(45 * 60_000),

  // Svalinn machine API (ADR 0087). Token stays in this process — not in forge.
  SVALINN_API_URL: z.string().default("https://svalinn.coldcodelabs.com"),
  SVALINN_MACHINE_TOKEN: z.string().default(""),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join("\n")}`);
  }
  // Fail closed in production: an empty BROKK_API_SECRET leaves every mutating
  // endpoint open (app.ts short-circuits the guard when no secret is set). That's
  // fine for local dev, but a prod boot without it is an open control plane.
  if (process.env.NODE_ENV === "production" && !parsed.data.BROKK_API_SECRET) {
    throw new Error(
      "BROKK_API_SECRET is required in production — without it every mutating API call is unauthenticated.",
    );
  }
  return parsed.data;
}
