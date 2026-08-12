import { Hono } from "hono"
import type { AppDeps } from "../app.js"
import { secretEquals } from "../secrets.js"
import { bulkSetFindingStatus, getBoard, getFindings, setFindingStatus } from "../svalinn-client.js"

function requireApi(c: { req: { header: (n: string) => string | undefined } }, secret: string): boolean {
  if (!secret) return false
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "")
  return secretEquals(token, secret)
}

export function svalinnRoutes(deps: AppDeps): Hono {
  const r = new Hono()
  const opts = () => ({
    baseUrl: deps.svalinnApiUrl ?? "",
    token: deps.svalinnMachineToken ?? "",
  })

  r.use("*", async (c, next) => {
    if (!requireApi(c, deps.apiSecret)) return c.json({ error: "unauthorized" }, 401)
    if (!deps.svalinnMachineToken) return c.json({ error: "svalinn federation unset" }, 503)
    return next()
  })

  r.get("/board", async (c) => {
    const board = await getBoard(opts())
    return c.json({ board })
  })

  r.get("/targets/:slug/findings", async (c) => {
    const slug = c.req.param("slug")
    const status = c.req.query("status") || "open"
    const findings = await getFindings(opts(), slug, status)
    return c.json({ slug, count: findings.length, findings })
  })

  r.post("/findings/:id/status", async (c) => {
    const id = c.req.param("id")
    const body = await c.req.json().catch(() => ({})) as { status?: string; note?: string; ref?: string }
    if (!body.status || !body.note) return c.json({ error: "status + note required" }, 400)
    await setFindingStatus(opts(), id, { status: body.status, note: body.note, ref: body.ref })
    return c.json({ ok: true, id, status: body.status })
  })

  r.post("/findings/status", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      ids?: string[]
      status?: string
      note?: string
      ref?: string
    }
    if (!body.status || !body.note || !body.ids?.length) {
      return c.json({ error: "ids + status + note required" }, 400)
    }
    const updated = await bulkSetFindingStatus(opts(), {
      ids: body.ids,
      status: body.status,
      note: body.note,
      ref: body.ref,
    })
    return c.json({ ok: true, updated })
  })

  return r
}
