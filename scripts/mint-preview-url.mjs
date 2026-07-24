#!/usr/bin/env node
/**
 * Mint a Brokk preview URL with ?__bk= (HMAC gate).
 *
 *   BROKK_PREVIEW_KEY=$(~/vault.sh get "BROKK_PREVIEW_KEY") \
 *     node scripts/mint-preview-url.mjs dekaprint-aio
 *
 * Never print or commit the secret. URL is short-lived (12h).
 */
import { createHmac } from "node:crypto";

const subdomain = (process.argv[2] || "").trim().toLowerCase();
const secret = (process.env.BROKK_PREVIEW_KEY || "").trim();
const domain = process.env.BROKK_PREVIEW_DOMAIN || "preview.coldcodelabs.com";
const TTL = 12 * 60 * 60;

if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(subdomain)) {
  console.error("usage: BROKK_PREVIEW_KEY=… node mint-preview-url.mjs <subdomain>");
  process.exit(1);
}
if (!secret) {
  console.error("BROKK_PREVIEW_KEY unset — get from Ice Vault bucket Brokk");
  process.exit(1);
}

const exp = Math.floor(Date.now() / 1000) + TTL;
const sig = createHmac("sha256", secret).update(`${subdomain}.${exp}`).digest("base64url");
const key = `${exp}.${sig}`;
const url = `https://${subdomain}.${domain}/?__bk=${encodeURIComponent(key)}`;
process.stdout.write(`${url}\n`);
