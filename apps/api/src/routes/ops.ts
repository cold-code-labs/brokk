import type { Run, Task, TaskStatus } from "@brokk/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppDeps } from "../app.js"
import { getFindings } from "../svalinn-client.js"

/**
 * Floor pulse + job handles.
 *
 * House cards paint border from task counts (queued/running/…). Callers that
 * start work (Svalinn smoke, QA, UI pack) need one place to poll without
 * inventing a Job entity — a job IS a task + its latest run.
 *
 * Kinds (svalinn-remediate, review, qa, …) share this pulse; only the brief
 * and createdBy differ at ingress.
 */

const HOT: TaskStatus[] = ["queued", "running", "review"]

export type ProjectPulse = {
  projectId: string
  name: string
  op: "idle" | "queued" | "forging" | "review" | "failed" | "objective"
  queued: number
  running: number
  review: number
  failed: number
  jobs: JobHandle[]
}

export type JobHandle = {
  taskId: string
  projectId: string
  title: string
  status: TaskStatus
  createdBy: string | null
  dedupeKey: string | null
  runId: string | null
  runStatus: Run["status"] | null
  events: string
  task: string
  runs: string
  updatedAt: string
}

function opOf(counts: { queued: number; running: number; review: number; failed: number }): ProjectPulse["op"] {
  if (counts.failed > 0) return "failed"
  if (counts.running > 0) return "forging"
  if (counts.queued > 0) return "queued"
  if (counts.review > 0) return "review"
  return "idle"
}

function handle(task: Task, run: Run | null): JobHandle {
  return {
    taskId: task.id,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    createdBy: task.createdBy ?? null,
    dedupeKey: task.dedupeKey ?? null,
    runId: run?.id ?? null,
    runStatus: run?.status ?? null,
    events: `/ops/jobs/${task.id}/events`,
    task: `/tasks/${task.id}`,
    runs: `/tasks/${task.id}/runs`,
    updatedAt: task.updatedAt,
  }
}

export function opsRoutes(deps: AppDeps): Hono {
  const r = new Hono()

  r.get("/", (c) =>
    c.json({
      service: "brokk-ops",
      endpoints: [
        { method: "GET", path: "/ops/pulse", query: "projectId?" },
        { method: "GET", path: "/ops/jobs/:taskId" },
        { method: "GET", path: "/ops/jobs/:taskId/events", note: "alias → /runs/by-task/:id/events" },
        {
          method: "POST",
          path: "/ops/start",
          body: "{kind, targetSlug|projectId|repoFullName, findingId?, brief?, title?}",
        },
      ],
      kinds: ["svalinn-smoke", "svalinn-remediate", "brief"],
      notes: [
        "pulse.op mirrors House card borders (queued amber · forging ember · idle quiet)",
        "a job is a task + latest run — poll /ops/jobs/:taskId until terminal",
      ],
    }),
  )

  /** Floor snapshot — what the House grid derives from tasks. */
  r.get("/pulse", async (c) => {
    const projectId = c.req.query("projectId")
    const projects = projectId
      ? ([await deps.store.getProject(projectId)].filter(Boolean) as NonNullable<
          Awaited<ReturnType<typeof deps.store.getProject>>
        >[])
      : await deps.store.listProjects()

    const allTasks = await deps.store.listTasks(projectId ? { projectId } : undefined)
    const byProject = new Map<string, Task[]>()
    for (const t of allTasks) {
      const list = byProject.get(t.projectId) ?? []
      list.push(t)
      byProject.set(t.projectId, list)
    }

    const pulse: ProjectPulse[] = []
    for (const p of projects) {
      const ts = byProject.get(p.id) ?? []
      const counts = {
        queued: ts.filter((t) => t.status === "queued").length,
        running: ts.filter((t) => t.status === "running").length,
        review: ts.filter((t) => t.status === "review").length,
        failed: ts.filter((t) => t.status === "failed").length,
      }
      const hot = ts.filter((t) => HOT.includes(t.status))
      const jobs: JobHandle[] = []
      for (const t of hot.slice(0, 20)) {
        const runs = await deps.store.listRunsByTask(t.id)
        jobs.push(handle(t, runs[0] ?? null))
      }
      if (counts.queued + counts.running + counts.review + counts.failed === 0 && !projectId) {
        continue // floor view: only projects with activity (unless scoped)
      }
      pulse.push({
        projectId: p.id,
        name: p.name,
        op: opOf(counts),
        ...counts,
        jobs,
      })
    }

    pulse.sort((a, b) => {
      const rank = { forging: 0, queued: 1, failed: 2, review: 3, objective: 4, idle: 5 } as const
      return rank[a.op] - rank[b.op] || b.running + b.queued - (a.running + a.queued)
    })

    return c.json({
      generatedAt: new Date().toISOString(),
      count: pulse.length,
      projects: pulse,
    })
  })

  r.get("/jobs/:taskId", async (c) => {
    const taskId = c.req.param("taskId")
    const task = await deps.store.getTask(taskId)
    if (!task) return c.json({ error: "job not found" }, 404)
    const runs = await deps.store.listRunsByTask(taskId)
    const run = runs[0] ?? null
    const project = await deps.store.getProject(task.projectId)
    return c.json({
      job: handle(task, run),
      project: project ? { id: project.id, name: project.name } : null,
      runs: runs.slice(0, 5).map((x) => ({
        id: x.id,
        status: x.status,
        startedAt: x.startedAt,
        endedAt: x.endedAt,
        prUrl: x.prUrl,
        error: x.error,
      })),
      terminal: ["done", "failed", "cancelled"].includes(task.status),
    })
  })

  /** SSE alias — same stream as /runs/by-task/:id/events (redirect keeps one code path). */
  r.get("/jobs/:taskId/events", (c) => {
    const taskId = c.req.param("taskId")
    return c.redirect(`/runs/by-task/${taskId}/events`, 307)
  })

  const StartBody = z.object({
    kind: z.enum(["svalinn-smoke", "svalinn-remediate", "brief"]).default("brief"),
    targetSlug: z.string().min(1).optional(),
    projectId: z.string().uuid().optional(),
    repoFullName: z.string().min(3).optional(),
    findingId: z.string().uuid().optional(),
    brief: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
    proposedOnly: z.boolean().optional(),
  })

  /**
   * Start an op through Brokk (ingress). For svalinn-smoke: pulls one open
   * finding via federation and enqueues a Forge card — House pulse turns amber.
   */
  r.post("/start", async (c) => {
    const parsed = StartBody.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
    const body = parsed.data

    let brief = body.brief ?? ""
    let title = body.title
    let dedupeKey: string | undefined
    let createdBy = "ops"
    let repoFullName = body.repoFullName
    let projectId = body.projectId
    let findingMeta: { id: string; severity: string; title: string } | null = null

    if (body.kind === "svalinn-smoke" || body.kind === "svalinn-remediate") {
      if (!deps.svalinnMachineToken) {
        return c.json({ error: "svalinn federation unset" }, 503)
      }
      const slug = body.targetSlug
      if (!slug && !repoFullName && !projectId) {
        return c.json({ error: "targetSlug (or projectId/repoFullName) required for svalinn ops" }, 400)
      }
      const targetSlug = slug ?? repoFullName?.split("/").pop() ?? "unknown"
      createdBy = "svalinn"
      const findings = await getFindings(
        { baseUrl: deps.svalinnApiUrl ?? "", token: deps.svalinnMachineToken },
        targetSlug,
        "open",
      )
      const pick =
        (body.findingId ? findings.find((f) => f.id === body.findingId) : null) ??
        findings.find((f) => f.severity === "critical") ??
        findings.find((f) => f.severity === "high") ??
        findings[0]
      if (!pick) return c.json({ error: `no open findings for ${targetSlug}` }, 404)
      findingMeta = { id: pick.id, severity: pick.severity, title: pick.title }
      const loc = pick.location as { file?: string; line?: number } | null
      const where = loc?.file ? `${loc.file}${loc.line != null ? `:${loc.line}` : ""}` : "(see finding)"
      brief =
        body.brief ??
        [
          `Svalinn ${body.kind === "svalinn-smoke" ? "SMOKE" : "remediate"} — ${targetSlug}`,
          ``,
          `Finding: ${pick.id}`,
          `Severity: ${pick.severity}`,
          `Title: ${pick.title}`,
          `Location: ${where}`,
          `Class: ${pick.class ?? "—"}`,
          `Cluster: ${pick.clusterKey ?? "—"}`,
          ``,
          pick.body?.slice(0, 2500) ?? "",
          ``,
          `Acceptance:`,
          `- Minimal fix on fix/svalinn-${targetSlug} (or stacked PR).`,
          `- Unit test when the sink is a pure function.`,
          `- Do NOT mark Svalinn fixed here — Brokk card done → awaiting_verification; ops closes via POST /svalinn/findings/:id/status after merge.`,
        ].join("\n")
      title = body.title ?? `[svalinn] ${pick.severity}: ${pick.title}`.slice(0, 200)
      dedupeKey = `svalinn:${targetSlug}:${pick.id}`
      if (!repoFullName && pick.targetRepoUrl) {
        const m = pick.targetRepoUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/i)
        if (m) repoFullName = m[1]!.replace(/\.git$/, "")
      }
      if (!repoFullName && !projectId) {
        repoFullName = `cold-code-labs/${targetSlug}`
      }
    }

    if (!brief) return c.json({ error: "brief required" }, 400)
    if (!projectId && !repoFullName) {
      return c.json({ error: "projectId or repoFullName required" }, 400)
    }

    // Delegate to ingress by internal fetch would recurse auth — call store via from-brief path.
    const ingressUrl = new URL("/ingress/cards", "http://ops.local")
    // Inline the same logic as ingress: use runs from-brief shape via store helpers
    // Prefer posting through the already-mounted ingress by constructing the body
    // and using deps the same way — import connectOne pattern from runs.
    const { connectOne } = await import("./repositories.js")

    let project = projectId ? await deps.store.getProject(projectId) : null
    if (!project && repoFullName) {
      const connected = await connectOne(deps, { fullName: repoFullName, defaultBranch: "main" }, true)
      project = connected.project
    }
    if (!project) return c.json({ error: "could not resolve project" }, 502)

    const makeHandle = (t: Task, deduped?: boolean) => ({
      kind: body.kind,
      finding: findingMeta,
      taskId: t.id,
      projectId: project!.id,
      repositoryId: project!.repositoryId,
      status: t.status,
      deduped: Boolean(deduped),
      pulse: `/ops/pulse?projectId=${project!.id}`,
      job: `/ops/jobs/${t.id}`,
      events: `/runs/by-task/${t.id}/events`,
      task: `/tasks/${t.id}`,
      runs: `/tasks/${t.id}/runs`,
    })

    if (dedupeKey) {
      const existing = await deps.store.findActiveTaskByDedupeKey(project.id, dedupeKey)
      if (existing) return c.json(makeHandle(existing, true), 200)
    }

    const task = await deps.store.insertTask({
      projectId: project.id,
      title: title ?? brief.split("\n")[0]!.slice(0, 200),
      brief,
      status: body.proposedOnly ? "backlog" : "queued",
      owner: "brokk",
      createdBy,
      dedupeKey: dedupeKey ?? null,
    })

    return c.json(makeHandle(task), 201)
  })

  return r
}
