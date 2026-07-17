import { mintPreviewKey, PREVIEW_KEY_PARAM } from "@brokk/core/preview-key";
import { NextResponse } from "next/server";
import { getSession } from "../../../lib/logto";

export const dynamic = "force-dynamic";

const PREVIEW_KEY = process.env.BROKK_PREVIEW_KEY ?? "";
const PREVIEW_DOMAIN = process.env.BROKK_PREVIEW_DOMAIN ?? "preview.coldcodelabs.com";

/**
 * Auth handoff for a preview.
 *
 * A preview is served from `<sub>.preview.<domain>` — a different origin from
 * this app, so the Logto session cookie never reaches the proxy. Rather than
 * teach the proxy about sessions (it would need Logto's secret and a round trip
 * per request), this route stands where the session already is: it checks who
 * you are, mints a short-lived key bound to ONE subdomain, and hands the browser
 * to the preview carrying it. The proxy trades the key for a cookie.
 *
 * The iframe points here, not at the preview, so the key is never in markup, a
 * client bundle, or anything the browser caches as page source.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sub: string }> },
) {
  const session = await getSession();
  if (!session.isAuthenticated) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  if (!PREVIEW_KEY) {
    return new NextResponse(
      "previews are not configured (BROKK_PREVIEW_KEY unset on the web)",
      { status: 503 },
    );
  }

  const { sub } = await params;
  // The subdomain becomes a hostname — anything but [a-z0-9-] could smuggle a
  // redirect to another host entirely.
  const subdomain = (sub ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(subdomain)) {
    return new NextResponse("bad preview name", { status: 400 });
  }

  const key = mintPreviewKey(PREVIEW_KEY, subdomain);
  const url = `https://${subdomain}.${PREVIEW_DOMAIN}/?${PREVIEW_KEY_PARAM}=${encodeURIComponent(key)}`;
  // 303 + no-store: the key is single-use-ish and short-lived; a cached redirect
  // would hand a stale one to the next visitor.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: url, "Cache-Control": "no-store" },
  });
}
