// ─────────────────────────────────────────────────────────────────────────────
// DataProvider (ADR 0027 §3.2) — the seam between the preview supervisor and
// whatever provisions a preview's data backend. The supervisor only ever calls
// `ensureEnv(project)` and spreads the returned env into the preview process.
//
//   passthroughProvider — default: the app runs on its own env (committed
//                         defaults / BROKK_PREVIEW_SECRETS_DIR files).
//   hauldr provider     — the CCL fleet default: provisions the <app>_dev
//                         Hauldr project (GoTrue+PostgREST+DB), injects the
//                         Supabase-compatible + template-light env contract,
//                         seeds the one-click demo user.
// ─────────────────────────────────────────────────────────────────────────────

import { createHmac } from "node:crypto";
import type { HauldrClient } from "./hauldr.js";

export interface DataProviderResult {
  /** Env vars spread into the preview process. */
  env: Record<string, string>;
  /** Env for the repo's own migrate script (scripts/hauldr-migrate.mjs shape);
   *  undefined = provider has no migration lane. */
  migrateEnv?: Record<string, string>;
}

export interface DataProvider {
  /** Human label for logs. */
  readonly name: string;
  /** Ensure the project's data backend exists and return its env. Called once
   *  per preview boot. Throw = provider failure (supervisor logs + boots the
   *  app anyway — some apps need no DB). */
  ensureEnv(project: string): Promise<DataProviderResult>;
}

/** No backend: the app runs on whatever env it already has. */
export const passthroughProvider: DataProvider = {
  name: "passthrough",
  ensureEnv: async () => ({ env: {} }),
};

/** The CCL fleet provider: Hauldr dev-DB per app. */
export function makeHauldrDataProvider(client: HauldrClient, controlUrl: string): DataProvider {
  return {
    name: "hauldr",
    async ensureEnv(project) {
      const hp = await client.ensureProject(project);
      const env: Record<string, string> = {
        // Full Supabase-compatible set so any Supabase/Hauldr client works.
        DATABASE_URL: hp.dbUrl,
        DIRECT_URL: hp.dbUrl, // Prisma direct connection alias
        SUPABASE_URL: hp.gotrueUrl,
        NEXT_PUBLIC_SUPABASE_URL: hp.gotrueUrl,
        SUPABASE_SERVICE_ROLE_KEY: hp.jwtSecret,
        SUPABASE_ANON_KEY: hp.jwtSecret,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: hp.jwtSecret,
        SUPABASE_JWT_SECRET: hp.jwtSecret,
        POSTGREST_URL: hp.postgrestUrl,
        // Brokk-namespaced aliases for apps that use BROKK_HAULDR_* vars
        BROKK_HAULDR_DB_URL: hp.dbUrl,
        BROKK_HAULDR_GOTRUE_URL: hp.gotrueUrl,
        BROKK_HAULDR_JWT_SECRET: hp.jwtSecret,
        BROKK_HAULDR_POSTGREST_URL: hp.postgrestUrl,
        // CCL template-light contract: it switches off stub mode only when
        // AUTH_MODE/DATA_MODE are set, and reads its own HAULDR_*/DATA_API_URL
        // vars (not the Supabase names). Without these the preview boots in
        // demo (stub) mode and never touches the Hauldr dev DB.
        AUTH_MODE: "hauldr",
        DATA_MODE: "postgrest",
        HAULDR_GOTRUE_URL: hp.gotrueUrl,
        HAULDR_JWT_SECRET: hp.jwtSecret,
        DATA_API_URL: hp.postgrestUrl,
        // Dev previews are throwaway demo environments — turn on the template's
        // one-click "Entrar como demo" login (the app gates it DEV/DEMO-only via
        // DEMO_LOGIN). We seed the matching user below so the click logs in.
        DEMO_LOGIN: "true",
        DEMO_LOGIN_EMAIL: DEMO_EMAIL,
        DEMO_LOGIN_PASSWORD: DEMO_PASSWORD,
      };
      // Seed the one-click demo user into this preview's GoTrue (idempotent),
      // so the injected DEMO_LOGIN button actually authenticates.
      await seedDemoUser(hp.gotrueUrl, hp.jwtSecret).catch((err) =>
        console.warn(
          `[preview-supervisor] demo-user seed failed for "${project}":`,
          err instanceof Error ? err.message : err,
        ),
      );
      return {
        env,
        migrateEnv: hp.migrateToken
          ? {
              HAULDR_CONTROL_URL: controlUrl,
              HAULDR_PROJECT: project,
              HAULDR_MIGRATE_TOKEN: hp.migrateToken,
            }
          : undefined,
      };
    },
  };
}

// ── one-click demo login (dev previews only) ─────────────────────────────────
// Default credentials the CCL template's DEMO_LOGIN button signs in with. Kept
// in sync with the template defaults (config/env.ts DEMO_LOGIN_EMAIL/PASSWORD).
const DEMO_EMAIL = "demo@coldcodelabs.com";
const DEMO_PASSWORD = "snowdemo123";

/** Mint a short-lived service_role JWT (HS256) from the project's GoTrue secret,
 *  so we can call GoTrue's admin API. Server-side only — never reaches a browser. */
function mintServiceToken(jwtSecret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({
    role: "service_role",
    iss: "brokk-preview",
    iat: now,
    exp: now + 300,
  })}`;
  const sig = createHmac("sha256", jwtSecret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

/** Ensure the demo user exists in a preview's GoTrue with the known demo
 *  password, via the admin API. Corrective + idempotent: creates the user, or —
 *  if it already exists (possibly with a different/older password) — resets its
 *  password and confirms its email so the one-click button always authenticates.
 *  No-op without a gotrue url + secret. */
async function seedDemoUser(gotrueUrl: string, jwtSecret: string): Promise<void> {
  if (!gotrueUrl || !jwtSecret) return;
  const base = gotrueUrl.replace(/\/+$/, "");
  const headers = {
    authorization: `Bearer ${mintServiceToken(jwtSecret)}`,
    "content-type": "application/json",
  };

  const create = await fetch(`${base}/admin/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD, email_confirm: true }),
  });
  if (create.ok) return; // fresh user created with the demo password
  const body = await create.text().catch(() => "");
  const exists =
    create.status === 422 ||
    create.status === 409 ||
    /already|registered|exists|duplicate/i.test(body);
  if (!exists) throw new Error(`GoTrue create → ${create.status} ${body.slice(0, 160)}`.trim());

  // Already there — reset its password + confirm so the demo creds work even if
  // a prior run (or a real signup) left it with a different password.
  const list = await fetch(`${base}/admin/users?per_page=200`, { headers });
  if (!list.ok) throw new Error(`GoTrue list → ${list.status}`);
  const data = (await list.json().catch(() => ({}))) as { users?: Array<{ id?: string; email?: string }> };
  const users = Array.isArray(data.users) ? data.users : [];
  const user = users.find((u) => (u.email ?? "").toLowerCase() === DEMO_EMAIL);
  if (!user?.id) throw new Error("demo user exists but was not found in the admin list");
  const upd = await fetch(`${base}/admin/users/${user.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ password: DEMO_PASSWORD, email_confirm: true }),
  });
  if (!upd.ok) {
    throw new Error(`GoTrue update → ${upd.status} ${(await upd.text().catch(() => "")).slice(0, 160)}`.trim());
  }
}
