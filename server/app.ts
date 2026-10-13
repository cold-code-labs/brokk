import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { designSchema, manifestSchema } from "../shared/design.ts";
import type { Kind, User } from "../shared/domain.ts";
import { canEdit, emptyData, kinds, roles } from "../shared/domain.ts";
import { publicEnvironment } from "../shared/environment.ts";
import type { Env } from "./auth.ts";
import { installAuth, secretOk } from "./auth.ts";
import type { Config } from "./config.ts";
import { designContract } from "./design.ts";
import {
  createPreviewProvider,
  environmentRecipe,
  type PreviewProvider,
  previewConfigured,
} from "./preview.ts";
import { contextFor, daily, devin, sessionId } from "./providers.ts";
import type { Store } from "./store.ts";
import { hash, Problem } from "./store.ts";

const text = z.string().trim().max(12000),
  title = z.string().trim().min(1).max(200),
  uuid = z.uuid();
const dataSchema = z
  .object({
    body: text.default(""),
    design: designSchema.nullable().default(null),
    acceptance: text.default(""),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
    screenId: z.union([uuid, z.literal("")]).default(""),
    value: z.string().max(300).default(""),
    category: z.string().max(80).default(""),
    targetId: z.union([uuid, z.literal("")]).default(""),
    targetVersion: z.number().int().nonnegative().default(0),
    scheduledAt: z
      .union([z.iso.datetime({ offset: true }), z.literal("")])
      .default(""),
  })
  .strict();
const recordSchema = z
  .object({
    kind: z.enum(kinds).exclude(["run"]),
    title,
    status: z
      .enum([
        "draft",
        "backlog",
        "ready",
        "building",
        "review",
        "done",
        "scheduled",
      ])
      .default("draft"),
    data: dataSchema,
  })
  .strict();
const states: Record<string, string[]> = {
  scope: ["draft"],
  task: ["backlog", "ready", "building", "review", "done"],
  screen: ["draft", "review"],
  token: ["draft", "review"],
  component: ["draft", "review"],
  review: ["review"],
  call: ["scheduled"],
  feedback: ["draft"],
};
export function buildApp(
  store: Store,
  cfg: Config,
  providers: { preview?: PreviewProvider } = {},
) {
  const app = new Hono<Env>();
  const preview = providers.preview || createPreviewProvider(cfg);
  const previewEnabled = () => previewConfigured(cfg);
  const previewAccess = async (id: string, user: User) => {
    const ws = await store.workspace(id, user);
    if (!canEdit(ws.organization.role))
      throw new Problem(403, "A equipe prepara e publica a preview.");
    if (!previewEnabled())
      throw new Problem(
        503,
        "A administração ainda precisa conectar os ambientes.",
      );
    return ws;
  };
  app.use(
    "*",
    secureHeaders({
      referrerPolicy: "no-referrer",
      permissionsPolicy: {
        camera: ["self"],
        microphone: ["self"],
        displayCapture: ["self"],
      },
    }),
  );
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 100000,
      onError: (c) => c.json({ error: "Conteúdo muito grande." }, 413),
    }),
  );
  app.use("/api/*", async (c, next) => {
    if (!["GET", "HEAD"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (
        c.req.header("sec-fetch-site") === "cross-site" ||
        (cfg.production &&
          !origin &&
          c.req.path !== "/api/integrations/var/handoff") ||
        (origin && origin !== cfg.origin)
      )
        return c.json({ error: "Origem não permitida." }, 403);
      if (!c.req.header("content-type")?.startsWith("application/json"))
        return c.json({ error: "Envie JSON." }, 415);
    }
    await next();
  });
  app.onError((e, c) => {
    if (e instanceof Problem)
      return c.json({ error: e.message }, e.status as 400);
    if (e instanceof z.ZodError)
      return c.json({ error: "Revise os campos informados." }, 400);
    console.error(
      "brokk_request_failed",
      e instanceof Error ? e.name : "unknown",
    );
    return c.json({ error: "A ação não foi concluída. Tente novamente." }, 500);
  });
  app.get("/api/health", async (c) => {
    await store.sql`select 1`;
    return c.json({
      ok: true,
      service: "brokk",
      version: "2.0.0",
      revision: cfg.revision,
    });
  });
  app.post("/api/integrations/var/handoff", async (c) => {
    if (
      !secretOk(
        c.req.header("authorization")?.replace(/^Bearer /, "") || "",
        cfg.varSecret,
      )
    )
      throw new Problem(401, "Integração não autorizada.");
    const input = z
      .object({
        organizationId: title,
        organizationName: title,
        projectId: title,
        projectName: title,
        objective: text,
        email: z
          .email()
          .max(200)
          .transform((x) => x.toLowerCase()),
        name: title,
        role: z.enum(["operator", "client", "reader"]),
      })
      .strict()
      .parse(await c.req.json());
    const result = await store.handoff(input);
    return c.json(
      {
        url: `${cfg.origin}/api/auth/handoff?ticket=${encodeURIComponent(result.ticket)}`,
        projectId: result.project.id,
      },
      201,
    );
  });
  installAuth(app, store, cfg);
  app.get("/api/organizations", async (c) =>
    c.json(await store.organizations(c.get("user"))),
  );
  app.post("/api/organizations", async (c) => {
    const input = z
      .object({ name: title })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await store.createOrganization(input.name, c.get("user")),
      201,
    );
  });
  app.post("/api/organizations/:id/members", async (c) => {
    const input = z
      .object({
        email: z
          .email()
          .max(200)
          .transform((x) => x.toLowerCase()),
        role: z.enum(roles),
      })
      .strict()
      .parse(await c.req.json());
    await store.member(
      uuid.parse(c.req.param("id")),
      input.email,
      input.role,
      c.get("user"),
    );
    return c.json({ ok: true });
  });
  app.get("/api/projects", async (c) =>
    c.json(await store.projects(c.get("user"))),
  );
  app.post("/api/projects", async (c) => {
    const input = z
      .object({ organizationId: uuid, name: title, objective: text })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await store.createProject(
        input.organizationId,
        input.name,
        input.objective,
        c.get("user"),
      ),
      201,
    );
  });
  app.get("/api/projects/:id", async (c) =>
    c.json(await store.workspace(uuid.parse(c.req.param("id")), c.get("user"))),
  );
  app.patch("/api/projects/:id", async (c) => {
    const input = z
      .object({
        version: z.number().int().positive(),
        name: title,
        objective: text,
        status: z.enum(["planning", "building", "review", "active", "paused"]),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await store.updateProject(
        uuid.parse(c.req.param("id")),
        input.version,
        input,
        c.get("user"),
      ),
    );
  });
  app.put("/api/projects/:id/repository", async (c) => {
    const input = z
      .object({
        repository: z
          .string()
          .max(200)
          .refine((x) => x === "" || /^[\w.-]+\/[\w.-]+$/.test(x)),
      })
      .strict()
      .parse(await c.req.json());
    await store.repository(
      uuid.parse(c.req.param("id")),
      input.repository,
      c.get("user"),
    );
    return c.json({ ok: true });
  });
  app.get("/api/projects/:id/design", async (c) =>
    c.json(
      designContract(
        await store.workspace(uuid.parse(c.req.param("id")), c.get("user")),
      ),
    ),
  );
  app.post("/api/projects/:id/design/import", async (c) => {
    const manifest = manifestSchema.parse(await c.req.json());
    const result = await store.importDesign(
      uuid.parse(c.req.param("id")),
      manifest,
      c.get("user"),
    );
    return c.json(result, result.imported ? 201 : 200);
  });
  app.get("/api/projects/:id/design/export", async (c) => {
    const contract = designContract(
      await store.workspace(uuid.parse(c.req.param("id")), c.get("user")),
    );
    if (!contract.validation.valid)
      throw new Problem(
        409,
        "Corrija a validação do design system antes de exportar.",
      );
    const format = z
      .enum(["contract", "tokens", "css", "manifest"])
      .parse(c.req.query("format") || "contract");
    const suffix =
      format === "css" ? "css" : format === "tokens" ? "tokens.json" : "json";
    c.header(
      "Content-Disposition",
      `attachment; filename="brokk-design-${format}.${suffix}"`,
    );
    c.header("Cache-Control", "private, no-store");
    if (format === "css")
      return c.body(contract.css, 200, {
        "Content-Type": "text/css; charset=utf-8",
      });
    return c.body(
      JSON.stringify(
        format === "tokens"
          ? contract.tokens
          : format === "manifest"
            ? contract.manifest
            : contract,
        null,
        2,
      ),
      200,
      {
        "Content-Type":
          format === "tokens"
            ? "application/design-tokens+json; charset=utf-8"
            : "application/json; charset=utf-8",
      },
    );
  });
  app.post("/api/projects/:id/records", async (c) => {
    const input = recordSchema.parse(await c.req.json());
    if (!states[input.kind].includes(input.status))
      throw new Problem(400, "Estado inválido para este item.");
    return c.json(
      await store.create(
        uuid.parse(c.req.param("id")),
        input.kind as Kind,
        input.title,
        input.status,
        { ...emptyData(), ...input.data },
        c.get("user"),
      ),
      201,
    );
  });
  app.patch("/api/projects/:id/records/:item", async (c) => {
    const input = z
      .object({
        version: z.number().int().positive(),
        title,
        status: z.enum([
          "draft",
          "backlog",
          "ready",
          "building",
          "review",
          "done",
        ]),
        data: dataSchema,
      })
      .strict()
      .parse(await c.req.json());
    const id = uuid.parse(c.req.param("id")),
      item = uuid.parse(c.req.param("item"));
    const ws = await store.workspace(id, c.get("user")),
      r = ws.records.find((x) => x.id === item);
    if (!r) throw new Problem(404, "Item não encontrado.");
    if (!states[r.kind]?.includes(input.status))
      throw new Problem(400, "Estado inválido.");
    return c.json(
      await store.update(
        id,
        item,
        input.version,
        input.title,
        input.status,
        { ...emptyData(), ...input.data },
        c.get("user"),
      ),
    );
  });
  app.get("/api/projects/:id/records/:item/versions", async (c) =>
    c.json(
      await store.versions(
        uuid.parse(c.req.param("id")),
        uuid.parse(c.req.param("item")),
        c.get("user"),
      ),
    ),
  );
  app.post("/api/projects/:id/reviews/:item/decision", async (c) => {
    const input = z
      .object({
        version: z.number().int().positive(),
        decision: z.enum(["approved", "changes"]),
        feedback: text,
      })
      .strict()
      .refine((x) => x.decision === "approved" || x.feedback.length > 0)
      .parse(await c.req.json());
    return c.json(
      await store.review(
        uuid.parse(c.req.param("id")),
        uuid.parse(c.req.param("item")),
        input.version,
        input.decision,
        input.feedback,
        c.get("user"),
      ),
    );
  });
  app.post("/api/projects/:id/calls/:item/notes", async (c) => {
    const input = z
      .object({
        version: z.number().int().positive(),
        body: z.string().trim().min(1).max(4000),
        category: z.enum(["liked", "change", "question", "decision"]),
        screenId: z.union([uuid, z.literal("")]),
      })
      .strict()
      .parse(await c.req.json());
    const id = uuid.parse(c.req.param("id"));
    const ws = await store.workspace(id, c.get("user"));
    if (
      input.screenId &&
      !ws.records.some((x) => x.id === input.screenId && x.kind === "screen")
    )
      throw new Problem(400, "Tela não encontrada.");
    return c.json(
      await store.mutateCall(
        id,
        uuid.parse(c.req.param("item")),
        input.version,
        c.get("user"),
        (r) => {
          if (r.status === "closed")
            throw new Problem(409, "Esta call já foi encerrada.");
          if (r.data.notes.length >= 300)
            throw new Problem(400, "Limite de notas atingido.");
          r.data.notes.push({
            id: randomUUID(),
            body: input.body,
            category: input.category,
            screenId: input.screenId,
            author: c.get("user").email,
            at: new Date().toISOString(),
          });
        },
      ),
    );
  });
  app.post("/api/projects/:id/calls/:item/join", async (c) => {
    const id = uuid.parse(c.req.param("id")),
      item = uuid.parse(c.req.param("item"));
    const ws = await store.workspace(id, c.get("user")),
      call = ws.records.find((x) => x.id === item && x.kind === "call");
    if (!call || call.status === "closed")
      throw new Problem(404, "Call indisponível.");
    const name = `brokk-${item.replace(/-/g, "")}`;
    let room = await daily(cfg, `/rooms/${name}`).catch((e) => {
      if (!(e instanceof Problem)) throw e;
      return null;
    });
    if (!room) {
      if (!canEdit(ws.organization.role))
        throw new Problem(409, "A equipe precisa abrir a sala primeiro.");
      room = await daily(cfg, "/rooms", {
        name,
        privacy: "private",
        properties: {
          exp: Math.floor(Date.now() / 1000) + 7200,
          max_participants: 8,
          enable_prejoin_ui: true,
          enable_screenshare: true,
          enable_chat: true,
        },
      });
    }
    if (!room.url || !/^https:\/\/[a-z0-9-]+\.daily\.co\//.test(room.url))
      throw new Problem(502, "Sala inválida.");
    const token = await daily(cfg, "/meeting-tokens", {
      properties: {
        room_name: name,
        user_name: c.get("user").name,
        user_id: c.get("user").id,
        exp: Math.floor(Date.now() / 1000) + 7200,
        is_owner: canEdit(ws.organization.role),
      },
    });
    return c.json({ url: room.url, token: token.token });
  });
  app.post("/api/projects/:id/calls/:item/close", async (c) => {
    const input = z
      .object({ version: z.number().int().positive() })
      .strict()
      .parse(await c.req.json());
    const id = uuid.parse(c.req.param("id")),
      ws = await store.workspace(id, c.get("user"));
    if (!canEdit(ws.organization.role))
      throw new Problem(403, "A equipe encerra a review.");
    const result = await store.closeCall(
      id,
      uuid.parse(c.req.param("item")),
      input.version,
      c.get("user"),
    );
    return c.json(result);
  });
  app.post("/api/projects/:id/development/context", async (c) => {
    const input = z
      .object({ taskId: uuid })
      .strict()
      .parse(await c.req.json());
    const ws = await store.workspace(
      uuid.parse(c.req.param("id")),
      c.get("user"),
    );
    if (!canEdit(ws.organization.role))
      throw new Problem(403, "A equipe solicita desenvolvimento.");
    const task = ws.records.find(
      (x) => x.id === input.taskId && x.kind === "task",
    );
    if (!task) throw new Problem(404, "Tarefa não encontrada.");
    const prompt = contextFor(
      ws,
      task,
      await store.environment(ws.project.id, c.get("user")),
    );
    return c.json({
      prompt,
      contextHash: hash(prompt),
      maxAcu: cfg.devin.maxAcu,
      repository: ws.project.repository,
    });
  });
  app.post("/api/projects/:id/development", async (c) => {
    const input = z
      .object({
        taskId: uuid,
        requestKey: uuid,
        contextHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(await c.req.json());
    const id = uuid.parse(c.req.param("id")),
      ws = await store.workspace(id, c.get("user"));
    if (!cfg.devin.key || !cfg.devin.orgId)
      throw new Problem(503, "Devin ainda não conectado.");
    if (!ws.project.repository)
      throw new Problem(
        409,
        "A administração precisa vincular um repositório.",
      );
    const scope = ws.records.find(
      (x) => x.kind === "scope" && x.status === "approved",
    );
    if (!scope)
      throw new Problem(
        409,
        "Aprove o escopo antes de iniciar o desenvolvimento.",
      );
    const task = ws.records.find(
      (x) => x.id === input.taskId && x.kind === "task",
    );
    if (!task) throw new Problem(404, "Tarefa não encontrada.");
    const environment = await store.environment(id, c.get("user"));
    if (environment && !environment.resources.application)
      throw new Problem(
        409,
        "Prepare a preview antes de iniciar o desenvolvimento.",
      );
    const prompt = contextFor(ws, task, environment);
    if (input.contextHash && input.contextHash !== hash(prompt))
      throw new Problem(
        409,
        "O contexto mudou. Prepare o desenvolvimento novamente.",
      );
    const reserved = await store.reserveRun(
      id,
      input.taskId,
      input.requestKey,
      c.get("user"),
      cfg.devin.dailyLimit,
      prompt,
      ws,
    );
    if (!reserved.created) return c.json(reserved.run);
    try {
      const remote = await devin(cfg, "", "POST", {
        prompt: reserved.run.data.body,
        title: task.title,
        repos: [ws.project.repository],
        max_acu_limit: cfg.devin.maxAcu,
        tags: [`brokk:${reserved.run.id}`],
      });
      const sid = sessionId(remote.session_id);
      return c.json(
        await store.providerUpdate(
          id,
          reserved.run.id,
          c.get("user"),
          "active",
          {
            sessionId: sid,
            providerStatus: String(remote.status || "running"),
          },
        ),
        201,
      );
    } catch (e) {
      await store.providerUpdate(
        id,
        reserved.run.id,
        c.get("user"),
        "uncertain",
        { providerStatus: "creation_unconfirmed" },
      );
      throw e;
    }
  });
  app.get("/api/projects/:id/development/:item", async (c) => {
    const id = uuid.parse(c.req.param("id")),
      ws = await store.workspace(id, c.get("user")),
      run = ws.records.find(
        (x) => x.id === c.req.param("item") && x.kind === "run",
      );
    if (!run?.data.sessionId)
      throw new Problem(409, "A criação da sessão ainda não foi confirmada.");
    const sid = sessionId(run.data.sessionId);
    const [remote, messages] = await Promise.all([
      devin(cfg, `/${sid}`),
      devin(cfg, `/${sid}/messages?first=50`),
    ]);
    const prs = Array.isArray(remote.pull_requests) ? remote.pull_requests : [];
    const pr = prs.find(
      (p: Record<string, string>) =>
        typeof p.pr_url === "string" &&
        p.pr_url.startsWith(
          `https://github.com/${ws.project.repository}/pull/`,
        ),
    );
    if (pr && canEdit(ws.organization.role) && run.data.resultUrl !== pr.pr_url)
      await store.providerUpdate(id, run.id, c.get("user"), "review", {
        resultUrl: pr.pr_url,
        providerStatus: String(remote.status_detail || remote.status || ""),
      });
    return c.json({
      status: remote.status,
      statusDetail: remote.status_detail,
      messages: messages.items || [],
      url: `https://app.devin.ai/sessions/${sid.replace("devin-", "")}`,
      pullRequests: prs.map((p: Record<string, string>) => ({
        url: p.pr_url,
        state: p.pr_state,
      })),
    });
  });
  app.get("/api/projects/:id/environment", async (c) => {
    const env = await store.environment(
      uuid.parse(c.req.param("id")),
      c.get("user"),
    );
    return c.json({
      connected: previewEnabled(),
      environment: env ? publicEnvironment(env) : null,
    });
  });
  app.put("/api/projects/:id/environment", async (c) => {
    const id = uuid.parse(c.req.param("id")),
      user = c.get("user"),
      ws = await previewAccess(id, user);
    if (ws.organization.role !== "admin")
      throw new Problem(403, "A administração configura a receita.");
    const input = z
      .object({
        slug: z.string().max(48),
        hostname: z.string().max(200).optional(),
        productionUrl: z.union([z.url(), z.literal("")]).optional(),
        profile: z.enum(["static", "application"]).optional(),
      })
      .strict()
      .parse(await c.req.json());
    const env = await store.configureEnvironment(
      id,
      environmentRecipe(cfg, id, ws.project.repository, input),
      user,
      cfg.preview.maxProjects,
    );
    return c.json(publicEnvironment(env));
  });
  app.post("/api/projects/:id/environment/prepare", async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    const id = uuid.parse(c.req.param("id")),
      user = c.get("user"),
      ws = await previewAccess(id, user);
    let env = await store.environment(id, user);
    if (!env)
      env = await store.configureEnvironment(
        id,
        environmentRecipe(cfg, id, ws.project.repository),
        user,
        cfg.preview.maxProjects,
        true,
      );
    if (
      env.state === "ready" ||
      (env.state === "waiting" && env.step === "prepared" && env.dataReady)
    )
      return c.json(publicEnvironment(env));
    const reserved = await store.reserveEnvironment(id, user);
    if (reserved.created) {
      const lease = reserved.environment.lease;
      void preview
        .prepare(reserved.environment, (patch) =>
          store.environmentUpdate(id, lease, patch, user),
        )
        .catch(async () => {
          try {
            await store.environmentUpdate(
              id,
              lease,
              {
                state: "uncertain",
                detail:
                  "A preparação não foi confirmada. A equipe pode verificar os recursos existentes sem duplicar a criação.",
              },
              user,
            );
          } catch {
            console.error("environment_update_unconfirmed");
          }
        });
    }
    return c.json(publicEnvironment(reserved.environment), 202);
  });
  app.post("/api/projects/:id/environment/refresh", async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    const id = uuid.parse(c.req.param("id")),
      user = c.get("user");
    await previewAccess(id, user);
    const env = await store.environment(id, user);
    if (!env) throw new Problem(409, "Prepare o ambiente primeiro.");
    if (env.state === "preparing") return c.json(publicEnvironment(env));
    const patch = await preview.inspect(env);
    return c.json(
      publicEnvironment(
        await store.environmentUpdate(id, env.lease, patch, user),
      ),
    );
  });
  app.get("/api/projects/:id/environment/deliveries", async (c) => {
    const env = await store.environment(
      uuid.parse(c.req.param("id")),
      c.get("user"),
    );
    if (!env || !previewEnabled()) return c.json([]);
    return c.json(await preview.pullRequests(env));
  });
  app.post("/api/projects/:id/environment/integrate", async (c) => {
    const input = z
      .object({ runId: uuid, head: z.string().regex(/^[a-f0-9]{40}$/) })
      .strict()
      .parse(await c.req.json());
    const id = uuid.parse(c.req.param("id")),
      user = c.get("user"),
      ws = await previewAccess(id, user);
    const run = ws.records.find(
      (r) => r.id === input.runId && r.kind === "run",
    );
    const env = await store.environment(id, user);
    if (!run || !env || !run.data.sessionId)
      throw new Problem(409, "A entrega ainda não está vinculada à execução.");
    const expected = `https://github.com/${env.repository}/pull/`,
      url = run.data.resultUrl;
    if (!url.startsWith(expected) || !/^\d+$/.test(url.slice(expected.length)))
      throw new Problem(
        409,
        "Esta entrega não pertence ao repositório do projeto.",
      );
    await preview.merge(env, Number(url.slice(expected.length)), input.head);
    await store.providerUpdate(id, run.id, user, "done", {
      providerStatus: "integrated_to_preview",
    });
    return c.json({ ok: true });
  });
  app.post("/api/projects/:id/environment/publish", async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    const id = uuid.parse(c.req.param("id")),
      user = c.get("user");
    await previewAccess(id, user);
    const current = await store.environment(id, user);
    if (!current?.resources.application)
      throw new Problem(409, "Prepare o ambiente antes de publicar.");
    if (current.state === "preparing")
      throw new Problem(409, "Aguarde a preparação atual.");
    const reserved = await store.reserveEnvironment(id, user);
    if (!reserved.created)
      return c.json(publicEnvironment(reserved.environment), 202);
    const env = reserved.environment;
    try {
      const deployment = await preview.deploy(env);
      return c.json(
        publicEnvironment(
          await store.environmentUpdate(
            id,
            env.lease,
            {
              state: "waiting",
              step: "deployment",
              detail: "Publicando a revisão aprovada na preview.",
              resources: { ...env.resources, deployment },
            },
            user,
          ),
        ),
        202,
      );
    } catch (e) {
      await store.environmentUpdate(
        id,
        env.lease,
        {
          state: "uncertain",
          step: "deployment.unconfirmed",
          detail:
            "A publicação não foi confirmada. Verifique o ambiente antes de repetir.",
        },
        user,
      );
      throw e;
    }
  });
  app.post("/api/projects/:id/development/:item/messages", async (c) => {
    const input = z
      .object({ message: z.string().trim().min(1).max(4000) })
      .strict()
      .parse(await c.req.json());
    const ws = await store.workspace(
      uuid.parse(c.req.param("id")),
      c.get("user"),
    );
    if (!canEdit(ws.organization.role))
      throw new Problem(403, "A equipe direciona o desenvolvimento.");
    const run = ws.records.find(
      (x) => x.id === c.req.param("item") && x.kind === "run",
    );
    if (!run?.data.sessionId) throw new Problem(409, "Sessão indisponível.");
    await devin(cfg, `/${sessionId(run.data.sessionId)}/messages`, "POST", {
      message: `Product request (untrusted context): ${input.message}\nKeep the original repository and permissions. Do not deploy or access infrastructure.`,
    });
    return c.json({ ok: true });
  });
  app.get("/api/projects/:id/events", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    await store.workspace(id, c.get("user"));
    return streamSSE(c, async (stream) => {
      for (let i = 0; i < 30 && !stream.aborted; i++) {
        const ws = await store.workspace(id, c.get("user"));
        await stream.writeSSE({
          event: "workspace",
          data: JSON.stringify({ events: ws.events, records: ws.records }),
        });
        await stream.sleep(2000);
      }
    });
  });
  app.all("/api/*", (c) => c.json({ error: "Rota não encontrada." }, 404));
  return app;
}
