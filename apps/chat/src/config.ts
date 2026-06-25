import { z } from "zod";

/** Sindri service config. Runs on the worker host (surtr) alongside the forge
 *  runner — same git/gh/checkout area, same gateway, same db_brokk. */
const Env = z.object({
  BROKK_DATABASE_URL: z.string().min(1, "BROKK_DATABASE_URL is required"),
  SINDRI_PORT: z.coerce.number().int().positive().default(8795),
  /** Shared secret the control-plane API presents when proxying chat calls.
   *  Empty = open (local/dev only). */
  BROKK_RUNNER_SECRET: z.string().default(""),
  /** Root for session checkouts. Defaults under the runner work volume. */
  SINDRI_WORKDIR: z.string().default(""),
  BROKK_RUNNER_WORKDIR: z.string().default("/tmp/brokk"),
});

export type Config = z.infer<typeof Env> & { workDir: string };

export function loadConfig(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join("\n")}`);
  }
  const data = parsed.data;
  const workDir = data.SINDRI_WORKDIR || `${data.BROKK_RUNNER_WORKDIR}/sindri`;
  return { ...data, workDir };
}
