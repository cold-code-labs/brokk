import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Preview access keys — the auth handoff between the Brokk web (which knows who
 * you are) and the preview proxy (which does not).
 *
 * Why this exists: previews are served from `<sub>.preview.<domain>`, a DIFFERENT
 * origin from the Brokk web, so the Logto session cookie never reaches the proxy.
 * Until this landed, the proxy simply resolved the subdomain and served — every
 * client's dev app was readable by anyone who guessed the name, and with
 * BROKK_LIVE_PREVIEW=1 what it served was the UNCOMMITTED working tree.
 *
 * The handoff: the web mints a short-lived key for a subdomain (session-gated),
 * the browser lands on the preview with `?__bk=<key>`, and the proxy trades it
 * for a cookie so the app's own asset/HMR requests carry it from then on.
 *
 * The key binds the subdomain: a key for `foo` does not open `bar`. It carries no
 * identity — it says "someone with a Brokk session asked for this preview,
 * recently", which is exactly the property the proxy needs and the most it can
 * check without a session store of its own.
 */

/** Query param the web appends and the proxy trades for a cookie. */
export const PREVIEW_KEY_PARAM = "__bk";
/** Cookie the proxy sets once a key checks out. */
export const PREVIEW_KEY_COOKIE = "__bk";
/** How long a key/cookie stays good. Long enough for a work session, short
 *  enough that a leaked URL in a screenshot or a log line goes stale. */
export const PREVIEW_KEY_TTL_S = 12 * 60 * 60;

function sign(secret: string, subdomain: string, exp: number): string {
  return createHmac("sha256", secret).update(`${subdomain}.${exp}`).digest("base64url");
}

/** Mint a key for one subdomain. Server-side only — the secret never ships to a
 *  browser. `now` is injectable for tests. */
export function mintPreviewKey(
  secret: string,
  subdomain: string,
  now: number = Date.now(),
): string {
  const exp = Math.floor(now / 1000) + PREVIEW_KEY_TTL_S;
  return `${exp}.${sign(secret, subdomain, exp)}`;
}

/** Constant-time verify. False on any malformed, expired, wrong-subdomain, or
 *  wrong-secret key — the caller never learns which, and an unset secret is
 *  closed rather than open. */
export function verifyPreviewKey(
  secret: string,
  subdomain: string,
  key: string,
  now: number = Date.now(),
): boolean {
  if (!secret || !key) return false;
  const dot = key.indexOf(".");
  if (dot < 1) return false;
  const exp = Number(key.slice(0, dot));
  if (!Number.isSafeInteger(exp) || exp * 1000 < now) return false;
  const presented = Buffer.from(key.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(secret, subdomain, exp), "utf8");
  if (presented.length !== expected.length) {
    // Compare against itself so the timing profile doesn't leak the length.
    timingSafeEqual(presented, presented);
    return false;
  }
  return timingSafeEqual(presented, expected);
}
