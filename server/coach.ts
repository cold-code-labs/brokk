import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import { emptyData, type User } from "../shared/domain.ts";
import { analysisSchema } from "../shared/review.ts";
import type { Env } from "./auth.ts";
import type { Config } from "./config.ts";
import { hash, Problem, type Store } from "./store.ts";
export const coachAuthorized = (cfg: Config, authorization?: string) =>
  cfg.suite.secret.length >= 32 &&
  hash(authorization?.replace(/^Bearer /, "") || "") === hash(cfg.suite.secret);
const point = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(4000),
    noteIds: z.array(z.uuid()).min(1).max(100),
  })
  .strict();
export function installCoach(app: Hono<Env>, store: Store, cfg: Config) {
  app.post("/api/integrations/a4-coach", async (c) => {
    if (!coachAuthorized(cfg, c.req.header("authorization")))
      throw new Problem(401, "Unauthorized");
    const p = z
      .object({
        operation: z.enum(["projects", "deliver"]),
        identity: z
          .object({
            id: z.uuid(),
            email: z.email(),
            name: z.string().min(1).max(200),
          })
          .strict(),
        organizationId: z.uuid(),
        meeting: z
          .object({
            id: z.uuid(),
            projectId: z.uuid(),
            title: z.string().min(1).max(200),
            recordingUrl: z.url(),
            notes: z
              .array(
                z
                  .object({
                    id: z.uuid(),
                    body: z.string().min(1).max(4000),
                    source: z.enum(["transcript", "manual"]),
                    at: z.iso.datetime(),
                  })
                  .strict(),
              )
              .max(2000),
            analysis: analysisSchema.extend({
              highlights: z.array(point).max(50),
            }),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(await c.req.json());
    const rows =
      await store.sql`select id,name from brokk_v2.organizations where external_id=${`a4:${p.organizationId}`}`;
    if (!rows.length)
      throw new Problem(
        404,
        "Empresa ainda não conectada ao Brokk. Abra o Brokk pela A4 primeiro.",
      );
    // A4 already checks current membership and service release. Scope the delegated actor to exactly this mapped company.
    const oid = String(rows[0].id);
    await store.suiteOrganization(
      p.organizationId,
      String(rows[0].name),
      p.identity.email,
      "operator",
    );
    const user: User = { ...p.identity, admin: false, suiteOrganization: oid };
    if (p.operation === "projects") return c.json(await store.projects(user));
    const m = p.meeting;
    if (!m) throw new Problem(400, "Reunião obrigatória.");
    const url = new URL(m.recordingUrl);
    if (
      url.origin !== cfg.suite.authority ||
      url.pathname !== "/live-coach" ||
      url.searchParams.get("meeting") !== m.id ||
      url.searchParams.get("org") !== p.organizationId
    )
      throw new Problem(400, "Gravação inválida.");
    await store.workspace(m.projectId, user);
    const ids = new Set(m.notes.map((n) => n.id));
    if (
      [...m.analysis.highlights, ...m.analysis.proposals].some((x) =>
        x.noteIds.some((id) => !ids.has(id)),
      )
    )
      throw new Problem(400, "Highlights sem evidência.");
    const call = await store.importCoach(m, user);
    return c.json({
      id: call.id,
      url: `${cfg.origin}/projects/${m.projectId}/calls`,
    });
  });
}
export function coachData(
  m: {
    id: string;
    recordingUrl: string;
    notes: {
      id: string;
      body: string;
      source: "manual" | "transcript";
      at: string;
    }[];
    analysis: z.infer<typeof analysisSchema> & {
      highlights: z.infer<typeof point>[];
    };
  },
  user: User,
) {
  return {
    ...emptyData(),
    sessionId: m.id,
    resultUrl: m.recordingUrl,
    body: "Reunião registrada pelo Live Coach da A⁴.",
    summary:
      m.analysis.summary +
      "\n\nHighlights\n" +
      m.analysis.highlights.map((h) => `${h.title}: ${h.body}`).join("\n"),
    notes: m.notes.map((n) => ({
      ...n,
      category: "decision" as const,
      author: user.email,
      screenId: "",
    })),
    reviewProposals: m.analysis.proposals.map((p) => ({
      ...p,
      id: randomUUID(),
      status: "pending" as const,
      taskId: "",
      reviewedBy: "",
    })),
  };
}
