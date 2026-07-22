import { mintPreviewKey, PREVIEW_KEY_PARAM } from "@brokk/core/preview-key";
import { NextResponse } from "next/server";
import { getSession } from "../../../lib/logto";
import { orgTenancyEnabled } from "../../../lib/rbac";

export const dynamic = "force-dynamic";

const PREVIEW_KEY = process.env.BROKK_PREVIEW_KEY ?? "";
const PREVIEW_DOMAIN = process.env.BROKK_PREVIEW_DOMAIN ?? "preview.coldcodelabs.com";
const API = process.env.BROKK_API_INTERNAL_URL ?? "http://127.0.0.1:8789";
const API_SECRET = process.env.BROKK_API_SECRET ?? "";

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
 *
 * ADR 0064: after auth, resolve the subdomain → project and refuse minting a
 * key for an org the caller cannot see (when BROKK_ORG_TENANCY=1).
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

  // Org scope (ADR 0064): resolve subdomain → project and refuse foreign orgs.
  // Staff with tenancy off still passes (API canSeeProject → true). Without
  // API_SECRET we cannot authorize — fail closed when tenancy is on.
  if (API_SECRET) {
    const res = await fetch(
      `${API.replace(/\/$/, "")}/previews/by-subdomain/${encodeURIComponent(subdomain)}`,
      {
        headers: {
          authorization: `Bearer ${API_SECRET}`,
          "x-brokk-actor": session.email ?? "",
          "x-brokk-org-ids": session.organizations.join(","),
          "x-brokk-is-staff": session.isCclStaff ? "1" : "0",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      },
    ).catch(() => null);
    if (!res || res.status === 404) {
      return new NextResponse("forbidden", { status: 403 });
    }
    if (!res.ok) {
      return new NextResponse("preview lookup failed", { status: 502 });
    }
  } else if (orgTenancyEnabled) {
    return new NextResponse("preview authorization unavailable", { status: 503 });
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
