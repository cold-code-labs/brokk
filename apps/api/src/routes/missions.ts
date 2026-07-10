// ── /missions — Regin, the mission coordinator (ADR 0027 §5.4) ────────────────
// A mission = one goal Regin plans (via Mímir), dispatches to the forge, watches
// and reacts to. These routes only create/read/cancel/resume the row — the brain
// is the reconciler in ../missions.ts (ticks every 30s). Writes ride the same
// api-secret guard as every other mutation (nothing special here); the Sindri
// chat tools bypass HTTP entirely (they hold the store).

import { MISSION_STATUSES, type MissionStatus } from "@brokk/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { loadMissionCards } from "../missions.js";

const CreateMissionBody = z.object({
  projectId: z.string().uuid(),
  goal: z.string().min(1).max(8000),
  autoApprove: z.boolean().default(true),
  chatSessionId: z.string().uuid().nullable().optional(),
  createdBy: z.string().optional(),
});

export function missionsRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  // Create a mission. It rests in `planning`; the reconciler picks it up on the
  // next tick (plans via Mímir, then dispatches / awaits board approval).
  r.post("/", async (c) => {
    const parsed = CreateMissionBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const project = await deps.store.getProject(parsed.data.projectId);
    if (!project) return c.json({ error: "project not found" }, 404);
    const mission = await deps.store.insertMission({
      projectId: parsed.data.projectId,
      goal: parsed.data.goal,
      autoApprove: parsed.data.autoApprove,
      chatSessionId: parsed.data.chatSessionId ?? null,
      createdBy: parsed.data.createdBy ?? c.req.header("x-brokk-actor") ?? "human",
    });
    await deps.store.addMissionEvent(mission.id, "created", {
      goal: mission.goal,
      autoApprove: mission.autoApprove,
    });
    return c.json(mission, 201);
  });

  r.get("/", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    const rawStatus = c.req.query("status") || undefined;
    const status = MISSION_STATUSES.includes(rawStatus as MissionStatus)
      ? (rawStatus as MissionStatus)
      : undefined;
    return c.json(await deps.store.listMissions({ projectId, status }));
  });

  // Mission + its trail + (when planned) the cards with live statuses.
  r.get("/:id", async (c) => {
    const mission = await deps.store.getMission(c.req.param("id"));
    if (!mission) return c.json({ error: "not found" }, 404);
    const events = await deps.store.listMissionEvents(mission.id);
    const cards = await loadMissionCards(deps.store, mission);
    return c.json({ mission, events, cards });
  });

  r.post("/:id/cancel", async (c) => {
    const mission = await deps.store.getMission(c.req.param("id"));
    if (!mission) return c.json({ error: "not found" }, 404);
    if (mission.status === "done" || mission.status === "failed" || mission.status === "cancelled") {
      return c.json({ error: `mission is already ${mission.status}` }, 409);
    }
    const updated = await deps.store.patchMission(mission.id, {
      status: "cancelled",
      detail: "cancelada",
    });
    await deps.store.addMissionEvent(mission.id, "status", {
      from: mission.status,
      to: "cancelled",
      actor: c.req.header("x-brokk-actor") ?? "human",
    });
    return c.json(updated);
  });

  // Un-block after an escalation: back to `running` — the next tick re-runs the
  // watch/react logic against whatever the human fixed on the board.
  r.post("/:id/resume", async (c) => {
    const mission = await deps.store.getMission(c.req.param("id"));
    if (!mission) return c.json({ error: "not found" }, 404);
    if (mission.status !== "blocked") {
      return c.json({ error: `only blocked missions can resume (status: ${mission.status})` }, 409);
    }
    // A mission blocked before planning finished goes back to planning, not running.
    const to: MissionStatus = mission.planId || mission.state.taskIds?.length ? "running" : "planning";
    const updated = await deps.store.patchMission(mission.id, { status: to, detail: null });
    await deps.store.addMissionEvent(mission.id, "status", {
      from: "blocked",
      to,
      actor: c.req.header("x-brokk-actor") ?? "human",
    });
    return c.json(updated);
  });

  return r;
}
