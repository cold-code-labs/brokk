import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/** Constant-time secret compare — avoids the byte-wise early-exit timing leak of
 *  `a === b` when checking a bearer/runner secret. Length pre-check first
 *  (timingSafeEqual throws on unequal-length buffers). */
export function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Authenticated encryption for Max tokens at rest (same scheme as the CCL Ice
 * Vault). Stored as `v1:iv:tag:ciphertext` (hex). Key = BROKK_SECRETS_KEY,
 * 32 bytes / 64 hex chars.
 */
const ALGO = "aes-256-gcm";

function key(): Buffer {
  const raw = process.env.BROKK_SECRETS_KEY;
  if (!raw) throw new Error("BROKK_SECRETS_KEY is not set (need 64 hex chars)");
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) throw new Error("BROKK_SECRETS_KEY must be 32 bytes (64 hex chars)");
  return buf;
}

export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("hex"), c.getAuthTag().toString("hex"), ct.toString("hex")].join(":");
}

export function unseal(stored: string): string {
  const [, ivHex, tagHex, ctHex] = stored.split(":");
  const d = createDecipheriv(ALGO, key(), Buffer.from(ivHex!, "hex"));
  d.setAuthTag(Buffer.from(tagHex!, "hex"));
  return d.update(Buffer.from(ctHex!, "hex")) + d.final("utf8");
}

/** Last 6 chars, for a non-secret UI hint like "…hiwAA". */
export function preview(token: string): string {
  return "…" + token.slice(-6);
}

/** Keys whose VALUE must never leave the API in clear (Env inspector / loadedEnv).
 *  Mirrors apps/forge/src/preview.ts — `(^|_)pat$` catches COOLIFY_PAT without
 *  matching PATH. Defense in depth: even a pre-redacted row or a buggy runner
 *  cannot leak through GET /previews. */
const SECRET_KEY_RE =
  /(secret|token|password|passwd|jwt|service_role|_key$|apikey|api_key|credential|(^|_)pat$)/i;

/** Redact an env map before the API returns (or stores) it. */
export function redactEnv(env: Record<string, string>): Record<string, string> {
  const mask = (v: string) => (v ? `••••${v.length > 4 ? v.slice(-4) : ""}` : v);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = SECRET_KEY_RE.test(k)
      ? mask(v)
      : v.replace(/:\/\/([^:@/]+):[^@/]+@/, (_m, user) => `://${user}:••••@`);
  }
  return out;
}

/** Apply redactEnv to a preview's loadedEnv (null stays null). */
export function redactPreviewEnv<T extends { loadedEnv?: Record<string, string> | null }>(
  preview: T,
): T {
  if (!preview.loadedEnv) return preview;
  return { ...preview, loadedEnv: redactEnv(preview.loadedEnv) };
}
