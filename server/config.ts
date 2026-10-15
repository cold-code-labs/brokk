export type Config = ReturnType<typeof readConfig>;
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === "production";
  const origin = (env.BROKK_ORIGIN || "http://127.0.0.1:40190").replace(
    /\/$/,
    "",
  );
  const config = {
    production,
    origin,
    port: Number(env.PORT || 40191),
    host: env.HOST || (production ? "::" : "127.0.0.1"),
    databaseUrl: env.BROKK_DATABASE_URL || "",
    adminEmails: (
      env.BROKK_ADMIN_EMAILS || (production ? "" : "admin@local.test")
    )
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
    devAuth: !production && env.BROKK_DEV_AUTH === "1",
    oidc: {
      endpoint: (env.LOGTO_ENDPOINT || "").replace(/\/$/, ""),
      appId: env.LOGTO_APP_ID || "",
      secret: env.LOGTO_APP_SECRET || "",
    },
    varSecret: env.BROKK_VAR_SECRET || "",
    suite: {
      authority: (env.A4_SUITE_ORIGIN || "").replace(/\/$/, ""),
      secret: env.A4_SUITE_CLIENT_SECRET || "",
      app: "brokk",
      prefix: "/api/auth/a4",
      origin,
    },
    devin: {
      key: env.DEVIN_API_KEY || "",
      orgId: env.DEVIN_ORG_ID || "",
      maxAcu: Number(env.DEVIN_MAX_ACU_PER_SESSION || 10),
      dailyLimit: Number(env.DEVIN_DAILY_LIMIT || 20),
    },
    coder: { workerSecret: env.BROKK_CURSOR_WORKER_SECRET || "" },
    daily: {
      key: env.DAILY_API_KEY || "",
      roomDomain: env.DAILY_ROOM_DOMAIN || "",
    },
    review: {
      speechKey: env.ASSEMBLYAI_API_KEY || "",
      gatewayUrl: (env.BROKK_REVIEW_AI_URL || "").replace(/\/$/, ""),
      gatewayKey: env.BROKK_REVIEW_AI_KEY || "",
      model: env.BROKK_REVIEW_AI_MODEL || "gpt-6-luna",
    },
    revision: env.SOURCE_COMMIT || env.BROKK_REVISION || "local",
    preview: {
      coolifyUrl: (env.BROKK_COOLIFY_URL || "").replace(/\/$/, ""),
      coolifyToken: env.BROKK_COOLIFY_TOKEN || "",
      project: env.BROKK_COOLIFY_PROJECT || "",
      server: env.BROKK_COOLIFY_SERVER || "",
      githubApp: env.BROKK_COOLIFY_GITHUB_APP || "",
      environment: env.BROKK_COOLIFY_ENVIRONMENT || "production",
      hauldrUrl: (env.BROKK_HAULDR_URL || "").replace(/\/$/, ""),
      hauldrKey: env.BROKK_HAULDR_KEY || "",
      githubToken: env.BROKK_GITHUB_TOKEN || "",
      woodpeckerUrl: (env.BROKK_WOODPECKER_URL || "").replace(/\/$/, ""),
      woodpeckerToken: env.BROKK_WOODPECKER_TOKEN || "",
      owner: env.BROKK_REPOSITORY_OWNER || "",
      template: env.BROKK_REPOSITORY_TEMPLATE || "",
      domain: env.BROKK_PREVIEW_DOMAIN || "",
      aliasDomain: env.BROKK_PREVIEW_ALIAS_DOMAIN || "",
      maxProjects: Number(env.BROKK_PREVIEW_MAX_PROJECTS || 30),
    },
  };
  if (!config.databaseUrl) throw new Error("BROKK_DATABASE_URL required");
  if (
    production &&
    (!origin.startsWith("https://") ||
      !config.oidc.endpoint ||
      !config.oidc.appId ||
      !config.oidc.secret ||
      !config.adminEmails.length)
  )
    throw new Error(
      "Production requires HTTPS, OIDC and administrator allowlist",
    );
  if (
    !Number.isFinite(config.devin.maxAcu) ||
    config.devin.maxAcu < 1 ||
    config.devin.maxAcu > 100 ||
    !Number.isFinite(config.devin.dailyLimit) ||
    config.devin.dailyLimit < 1 ||
    config.devin.dailyLimit > 100
  )
    throw new Error("Invalid Devin budget");
  return config;
}
