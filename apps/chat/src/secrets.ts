import { createDecipheriv } from "node:crypto";

// Unseal a Max seat token for per-user chat routing. Mirrors the canonical sealer
// in apps/api/src/secrets.ts (the API seals on /connect; Sindri only ever reads).
// Format `v1:iv:tag:ciphertext` (hex), AES-256-GCM, key = BROKK_SECRETS_KEY.
const ALGO = "aes-256-gcm";

function key(): Buffer {
  const raw = process.env.BROKK_SECRETS_KEY;
  if (!raw) throw new Error("BROKK_SECRETS_KEY is not set (need 64 hex chars)");
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) throw new Error("BROKK_SECRETS_KEY must be 32 bytes (64 hex chars)");
  return buf;
}

export function unseal(stored: string): string {
  const [, ivHex, tagHex, ctHex] = stored.split(":");
  const d = createDecipheriv(ALGO, key(), Buffer.from(ivHex!, "hex"));
  d.setAuthTag(Buffer.from(tagHex!, "hex"));
  return d.update(Buffer.from(ctHex!, "hex")) + d.final("utf8");
}
