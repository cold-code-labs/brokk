import type { Store } from "@brokk/db";
import type { BancadaService } from "./bancada.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { version } from "../package.json";
import { conversationsRoutes } from "./routes/conversations.js";
import { fleetRoutes } from "./routes/fleet.js";
import { githubRoutes } from "./routes/github.js";
import { missionsRoutes } from "./routes/missions.js";
import { plansRoutes } from "./routes/plans.js";
import { previewsRoutes } from "./routes/previews.js";
import { projectsRoutes } from "./routes/projects.js";
import { repositoriesRoutes } from "./routes/repositories.js";
import { runsRoutes } from "./routes/runs.js";
import { secretEquals } from "./secrets.js";
import { studioRoutes } from "./routes/studio.js";
import { subscriptionsRoutes } from "./routes/subscriptions.js";
import { tasksRoutes } from "./routes/tasks.js";
import { usersRoutes } from "./routes/users.js";
import { webhooksRoutes } from "./routes/webhooks.js";
import { bancadasRoutes } from "./routes/bancadas.js";
import { ingressRoutes } from "./routes/ingress.js";
import { opsRoutes } from "./routes/ops.js";
import { svalinnRoutes } from "./routes/svalinn.js";

export interface AppDeps {
  store: Store;
  /** The Coder runtime (ADR 0100). Absent = /bancadas answers 503; the control
   *  plane still serves everything else. */
  bancadas?: BancadaService;
  /** Shared secret of the old runner hop. Kept only because `previews` writes
   *  still accept it while the cold environments move to Heimdall; nothing in
   *  this repo presents it anymore. */
  runnerSecret: string;
  /** Bearer secret guarding API calls when set (GET included). The web
   *  proxy injects it server-side. Empty = open (local/dev). */
  apiSecret: string;
  /** GitHub webhook HMAC secret. Empty = skip signature check (local dev). */
  githubWebhookSecret: string;
  /** PAT for gh (open Story PR, review reconciler). Empty = those paths 503/off. */
  githubToken?: string;
  /** Base URL of Eitri HTTP trigger (e.g. http://reviewer:8796). Empty = skip. */
  eitriUrl?: string;
  /** Hauldr control-plane base URL + bearer, for the read-only Studio (resolve a
   *  preview's Hauldr project → dbUrl → introspect). Both empty = /studio off. */
  /** Heimdall's WEB base — the Studio resolves a dev lane's db url through the
   *  scoped /api/agent/lanes proxy, never the data plane's management key. */
  heimdallAgentUrl?: string;
  heimdallAgentToken?: string;
  /** Heimdall control-plane base URL + bearer — the provisioning engine "Nova
   *  Conversa" (ADR 0038) calls to birth a dev-first app. Both empty =
   *  /conversations → 503. */
  heimdallUrl?: string;
  heimdallToken?: string;
  /** Mint a short-lived GitHub token for a repo (GitHub App). Used to read a
   *  repository's manifests when deciding its runtime, and to open PRs. */
  mintGitToken?: (repoFullName: string) => Promise<string | null>;
  /** Svalinn machine API (ADR 0087 federation). Empty token → /svalinn 503. */
  svalinnApiUrl?: string;
  svalinnMachineToken?: string;
}

const PUBLIC_PROBES = new Set(["/health", "/ping", "/version"]);

/** CORS allowlist: BROKK_WEB_URL + comma-separated BROKK_CORS_ORIGINS. Empty in
 *  production → no browser cross-origin (BFF same-origin is enough). Dev without
 *  a list keeps `*` so local tooling still works. */
function corsOrigin(): string | string[] {
  const list = [process.env.BROKK_WEB_URL, ...(process.env.BROKK_CORS_ORIGINS ?? "").split(",")]
    .map((s) => (s ?? "").trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (list.length > 0) return list.length === 1 ? list[0]! : list;
  return process.env.NODE_ENV === "production" ? "" : "*";
}

/** Assemble the control-plane HTTP app from its dependencies. Pure wiring — no
 *  I/O at construction — so it can be exercised with a fake store. */
export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: corsOrigin(),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // Errors as JSON problem objects. Never echo exception text to clients.
  app.onError((err, c) => {
    console.error("[api]", err instanceof Error ? err.stack || err.message : err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, service: "brokk-api" }));
  app.get("/ping", (c) => c.json({ pong: true }));
  app.get("/version", (c) => c.json({ version }));

  // Tenancy headers are only trusted on an authenticated hop (API or runner
  // secret). Direct callers without a bearer cannot elevate via spoofed
  // x-brokk-*; actorFrom reads brokkTrustedHop (see actor.ts).
  app.use("*", async (c, next) => {
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const trusted =
      (!deps.apiSecret && !deps.runnerSecret) ||
      (Boolean(deps.apiSecret) && secretEquals(token, deps.apiSecret)) ||
      (Boolean(deps.runnerSecret) && secretEquals(token, deps.runnerSecret));
    c.set("brokkTrustedHop", trusted);
    return next();
  });

  // Guard ALL methods behind the API secret when set (including GET/HEAD). The
  // browser reaches the API only through the web's server-side proxy, which
  // injects the bearer; a direct caller can't read or mutate the control plane.
  // Exemptions: public probes, and routes that self-authenticate (runner secret /
  // GitHub HMAC).
  app.use("*", async (c, next) => {
    if (!deps.apiSecret) return next();
    if (c.req.method === "OPTIONS") return next();
    const path = c.req.path;
    if (PUBLIC_PROBES.has(path)) return next();
    // Só duas isenções sobrevivem, e cada uma se autentica sozinha:
    //   • /webhooks  — HMAC do GitHub
    //   • /bancadas/git-credential — o segredo daquela bancada
    // As antigas (/runner, /driver-runs, /previews e as duas escritas de /runs)
    // existiam para o forge, que morreu com a ADR 0100. Cada uma delas foi
    // acrescentada DEPOIS de quebrar produção — a do PR #118 foi a quarta — e
    // todas eram por PREFIXO, o que pré-autoriza qualquer rota futura embaixo
    // daquele caminho. A de baixo é por caminho EXATO, de propósito.
    if (
      path.startsWith("/webhooks") ||
      path === "/bancadas/git-credential"
    )
      return next();
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (secretEquals(token, deps.apiSecret)) return next();
    return c.json({ error: "unauthorized" }, 401);
  });

  app.route("/repositories", repositoriesRoutes(deps));
  app.route("/github", githubRoutes(deps));
  app.route("/conversations", conversationsRoutes(deps));
  app.route("/fleet", fleetRoutes(deps));
  app.route("/projects", projectsRoutes(deps));
  app.route("/plans", plansRoutes(deps));
  app.route("/previews", previewsRoutes(deps));
  app.route("/users", usersRoutes(deps));
  app.route("/subscriptions", subscriptionsRoutes(deps));
  app.route("/tasks", tasksRoutes(deps));
  app.route("/missions", missionsRoutes(deps));
  app.route("/runs", runsRoutes(deps));
  app.route("/bancadas", bancadasRoutes(deps));
  app.route("/ingress", ingressRoutes(deps));
  app.route("/ops", opsRoutes(deps));
  app.route("/svalinn", svalinnRoutes(deps));
  app.route("/studio", studioRoutes(deps));
  app.route("/webhooks", webhooksRoutes(deps));

  return app;
}
