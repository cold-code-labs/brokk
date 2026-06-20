import { z } from "zod";

/** Control-plane configuration, read once from the environment at boot. The
 *  runner secret defaults to empty so the API can boot for local UI work;
 *  runner endpoints reject requests when no secret is configured. */
const Env = z.object({
  BROKK_DATABASE_URL: z.string().min(1, "BROKK_DATABASE_URL is required"),
  BROKK_API_PORT: z.coerce.number().int().positive().default(8789),

  // Shared secret the runner presents on /runner/* and /runs/:id/{events,complete}.
  BROKK_RUNNER_SECRET: z.string().default(""),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join("\n")}`);
  }
  return parsed.data;
}
