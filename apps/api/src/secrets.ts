import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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
