import { UserScope, type LogtoNextConfig } from "@logto/next";
import { getLogtoContext, signIn, signOut, handleSignIn } from "@logto/next/server-actions";

import { highestRole } from "./rbac";

const endpoint = process.env.LOGTO_ENDPOINT;
const appId = process.env.LOGTO_APP_ID;
const appSecret = process.env.LOGTO_APP_SECRET;
const baseUrl = process.env.LOGTO_BASE_URL;
const cookieSecret = process.env.LOGTO_COOKIE_SECRET;

/**
 * Auth turns on only when fully configured. Without a Logto, the forge runs as
 * an open shell — so `pnpm dev` and a fresh clone work with zero setup. Point it
 * at CCL's Logto (the five LOGTO_* vars) to put real SSO login in front.
 */
export const authEnabled = Boolean(endpoint && appId && appSecret && baseUrl && cookieSecret);

export const logtoConfig: LogtoNextConfig = {
  endpoint: endpoint ?? "",
  appId: appId ?? "",
  appSecret: appSecret ?? "",
  baseUrl: baseUrl ?? "",
  cookieSecret: cookieSecret ?? "",
  cookieSecure: process.env.NODE_ENV === "production",
  scopes: [UserScope.Email, UserScope.Profile, UserScope.Roles],
};

export type Session = {
  isAuthenticated: boolean;
  authDisabled: boolean;
  name: string;
  email?: string;
  roles: string[];
  role?: string;
};

export async function getSession(): Promise<Session> {
  if (!authEnabled) {
    // Fail closed in production: without Logto wired, the open shell would hand
    // every visitor an authenticated *owner* session (below) — turning a deploy
    // that forgot a LOGTO_* var into a fully open control plane. The auth-disabled
    // convenience is for local dev only.
    // BROKK_OPEN_SHELL=1 is the one deliberate opt-out: it lets the litr
    // walkthrough harness run the standalone production build on a loopback
    // port for real-render screenshots. It must be SET on purpose — a deploy
    // that merely forgot LOGTO_* still fails closed. Never set it on anything
    // reachable from outside localhost.
    if (process.env.NODE_ENV === "production" && process.env.BROKK_OPEN_SHELL !== "1") {
      throw new Error(
        "Refusing to serve without auth in production: set the five LOGTO_* vars (endpoint, app id, app secret, base url, cookie secret).",
      );
    }
    const roles = ["Proprietário"];
    return { isAuthenticated: true, authDisabled: true, name: "Local", roles, role: highestRole(roles) };
  }

  const ctx = await getLogtoContext(logtoConfig);
  const claims = ctx.claims;
  const roles = claims?.roles ?? [];

  return {
    isAuthenticated: ctx.isAuthenticated,
    authDisabled: false,
    name: claims?.name ?? claims?.username ?? claims?.email ?? "—",
    email: claims?.email ?? undefined,
    roles,
    role: highestRole(roles),
  };
}

export { signIn, signOut, handleSignIn };
