import { randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import type { Note } from "../shared/domain.ts";
import type { Env } from "./auth.ts";
import { secretOk } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import { hash, Problem } from "./store.ts";

export async function coderMessage(
  store: Store,
  projectId: string,
  runId: string,
  body: string,
  author: string,
) {
  await store.sql.begin(async (db) => {
    const rows =
      await db`select data from brokk_v2.artifacts where id=${runId} and project_id=${projectId} and kind='run' for update`;
    if (!rows.length) throw new Problem(404, "Execução não encontrada.");
    const notes: Note[] = rows[0].data.notes || [];
    if (notes.length >= 200)
      throw new Problem(409, "Limite de mensagens atingido.");
    notes.push({
      id: randomUUID(),
      body,
      author,
      at: new Date().toISOString(),
      category: "question",
      screenId: "",
    });
    await db`update brokk_v2.artifacts set data=data || ${db.json({ notes })},version=version+1,updated_at=now() where id=${runId}`;
    await db`insert into brokk_v2.events(id,project_id,actor,action,detail) values (${randomUUID()},${projectId},${author},'run.message',${body.slice(0, 200)})`;
  });
}
export async function cursorAvailable(store: Store, repository = "") {
  const rows =
    await store.sql`select owner from brokk_v2.coder_workers where ready and updated_at>now()-interval '60 seconds' and (${repository === ""} or (repositories ? ${repository} or repositories ? ${repository.split("/")[0] + "/*"})) limit 1`;
  return rows.length > 0;
}
export function installCoderWorker(app: Hono<Env>, store: Store, cfg: Config) {
  app.use("/api/worker/cursor/*", async (c, next) => {
    if (
      !cfg.coder.workerSecret ||
      !secretOk(
        c.req.header("authorization")?.replace(/^Bearer /, "") || "",
        cfg.coder.workerSecret,
      )
    )
      throw new Problem(401, "Worker não autorizado.");
    await next();
  });
  app.post("/api/worker/cursor/presence", async (c) => {
    const input = z
      .object({
        owner: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/),
        revision: z.string().max(100),
        ready: z.boolean(),
        repositories: z
          .array(z.string().regex(/^[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)$/))
          .min(1)
          .max(100),
      })
      .strict()
      .parse(await c.req.json());
    await store.sql.begin(async (db) => {
      await db`insert into brokk_v2.coder_workers(owner,revision,ready,repositories) values (${input.owner},${input.revision},${input.ready},${db.json(input.repositories)}) on conflict(owner) do update set revision=excluded.revision,ready=excluded.ready,repositories=excluded.repositories,updated_at=now()`;
      const expired =
        await db`update brokk_v2.coder_jobs set state='failed',updated_at=now() where state='working' and lease_until<now() returning run_id,project_id`;
      for (const row of expired) {
        await db`update brokk_v2.artifacts set status='failed',data=data || ${db.json({ providerStatus: "lease_expired", summary: "O worker perdeu a concessão. Tentativa encerrada; nenhum trabalho foi repetido automaticamente." })},version=version+1,updated_at=now() where id=${row.run_id}`;
        await db`insert into brokk_v2.events(id,project_id,actor,action,detail) values (${randomUUID()},${row.project_id},'Brokk','run.failed','Worker sem concessão; execução preservada sem repetição.')`;
      }
    });
    return c.json({ ok: true });
  });
  app.post("/api/worker/cursor/claim", async (c) => {
    const input = z
      .object({ owner: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/) })
      .strict()
      .parse(await c.req.json());
    const result = await store.sql.begin(async (db) => {
      await db`select owner from brokk_v2.coder_workers where owner=${input.owner} for update`;
      const rows =
        await db`select j.run_id,j.project_id,a.title,a.data,p.repository,e.profile from brokk_v2.coder_jobs j join brokk_v2.artifacts a on a.id=j.run_id join brokk_v2.projects p on p.id=j.project_id join brokk_v2.environments e on e.project_id=j.project_id where j.state='queued' and a.status='launching' and exists(select 1 from brokk_v2.coder_workers w where w.owner=${input.owner} and w.ready and w.updated_at>now()-interval '60 seconds' and (w.repositories ? p.repository or w.repositories ? (split_part(p.repository,'/',1) || '/*'))) and not exists(select 1 from brokk_v2.coder_jobs busy where busy.owner=${input.owner} and busy.state='working' and busy.lease_until>now()) and e.resources->>'application'<>'' order by j.updated_at for update of j skip locked limit 1`;
      if (!rows.length) return null;
      const row = rows[0],
        lease = randomBytes(32).toString("hex");
      await db`update brokk_v2.coder_jobs set state='working',owner=${input.owner},lease_hash=${hash(lease)},lease_until=now()+interval '2 minutes',updated_at=now() where run_id=${row.run_id}`;
      await db`update brokk_v2.artifacts set status='active',data=data || ${db.json({ providerStatus: "working" })},version=version+1,updated_at=now() where id=${row.run_id}`;
      return {
        runId: row.run_id,
        projectId: row.project_id,
        repository: row.repository,
        title: row.title,
        baseBranch: "preview",
        profile: row.profile,
        prompt: row.data.body,
        lease,
      };
    });
    return c.json(result);
  });
  app.post("/api/worker/cursor/:id/report", async (c) => {
    const input = z
      .object({
        lease: z.string().regex(/^[a-f0-9]{64}$/),
        state: z.enum(["working", "review", "failed"]).default("working"),
        sessionId: z
          .string()
          .regex(/^[a-zA-Z0-9_-]{8,100}$/)
          .optional(),
        message: z.string().trim().max(4000).optional(),
        resultUrl: z.string().max(300).optional(),
      })
      .strict()
      .parse(await c.req.json());
    const id = z.uuid().parse(c.req.param("id"));
    const result = await store.sql.begin(async (db) => {
      const rows =
        await db`select j.*,a.data,p.repository from brokk_v2.coder_jobs j join brokk_v2.artifacts a on a.id=j.run_id join brokk_v2.projects p on p.id=j.project_id where j.run_id=${id} and j.lease_hash=${hash(input.lease)} and (j.lease_until>now() or ${input.state === "failed"}) and j.state='working' for update of j,a`;
      if (!rows.length)
        throw new Problem(
          409,
          "A execução perdeu a concessão do worker. Não repita o trabalho automaticamente.",
        );
      const row = rows[0],
        notes: Note[] = row.data.notes || [];
      if (
        input.resultUrl &&
        !new RegExp(
          `^https://github\\.com/${String(row.repository).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/[0-9]+$`,
        ).test(input.resultUrl)
      )
        throw new Problem(400, "Entrega fora do repositório autorizado.");
      if (input.state === "failed" && input.resultUrl)
        throw new Problem(
          400,
          "Uma execução interrompida não pode apresentar entrega para integrar.",
        );
      if (input.state === "review" && !input.resultUrl)
        throw new Problem(400, "Informe a PR para revisão.");
      const safe = (s: string) =>
        s
          .replace(/(?:apk_|cog_)[A-Za-z0-9_-]+/g, "[redigido]")
          .replace(/Bearer\s+[^\s"']+/gi, "[redigido]");
      if (input.message && notes.length < 200)
        notes.push({
          id: randomUUID(),
          body: safe(input.message),
          author: "Cursor CLI",
          at: new Date().toISOString(),
          category: "decision",
          screenId: "",
        });
      const patch = {
        attempts: (row.data.attempts || []).map(
          (attempt: { provider: string; status: string; at: string }) =>
            attempt.provider === "cursor"
              ? { ...attempt, status: input.state }
              : attempt,
        ),
        notes,
        providerStatus: input.state,
        ...(input.resultUrl ? { resultUrl: input.resultUrl } : {}),
        ...(input.sessionId ? { sessionId: "cursor-" + input.sessionId } : {}),
      };
      await db`update brokk_v2.coder_jobs set state=${input.state},session_id=${input.sessionId || row.session_id},lease_until=now()+interval '2 minutes',updated_at=now() where run_id=${id}`;
      if (input.message || input.state !== "working" || input.sessionId) {
        await db`update brokk_v2.artifacts set status=${input.state === "working" ? "active" : input.state},data=data || ${db.json(patch)},version=version+1,updated_at=now() where id=${id}`;
        await db`insert into brokk_v2.events(id,project_id,actor,action,detail) values (${randomUUID()},${row.project_id},'Cursor CLI',${"run." + input.state},${input.resultUrl || "Execução do worker atualizada."})`;
      }
      return {
        messages: notes
          .map((n, i) => ({ index: i, ...n }))
          .filter((n) => n.author !== "Cursor CLI"),
      };
    });
    return c.json(result);
  });
}
