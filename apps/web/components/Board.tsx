"use client";

import type { Preview, Project, Run, RunEvent, Task, TaskEvent, TaskOwner } from "@brokk/sdk";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  Brain,
  Camera,
  CheckCircle2,
  ChevronRight,
  Columns3,
  FileEdit,
  FileText,
  GitPullRequest,
  Hand,
  ListTodo,
  Loader2,
  MoreHorizontal,
  Plus,
  Rows3,
  ScrollText,
  Search,
  TerminalSquare,
  User as UserIcon,
  Undo2,
  Wrench,
  XCircle,
} from "lucide-react";
import {
  Main,
  Banner,
  Button,
} from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";
import { useToast } from "./Toaster";
import { analysis as analysisApi, type AnalysisQuestion, type TaskAnalysis } from "../lib/chat";
import { useProject } from "../lib/project-context";
import { STATUS_COLOR, STATUS_LABEL, t } from "../lib/theme";
import { AgentAvatar } from "./AgentAvatar";
import { PreviewChip } from "./PreviewChip";

const COLUMNS = ["backlog", "analysis", "queued", "running", "review", "done", "failed"] as const;

/** Status → forge-chip class. The ember is reserved for running work — the one
 *  warm thing on the board; accent flags review/PR; everything else stays cold. */
const chipClass = (s: string) =>
  `forge-chip${s === "running" ? " is-ember" : s === "review" ? " is-accent" : ""}`;

/** Board for a single project. `projectId` selects the repo's board; when omitted
 *  it falls back to the first project (legacy single-project entry). */
export default function Board({ projectId }: { projectId?: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const toast = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Linear-ish controls: view mode, owner lane filter, free-text search, new-card
  // modal. The search box gets a ref so the `/` shortcut can focus it.
  const [view, setView] = useState<"board" | "list">("board");
  const [ownerFilter, setOwnerFilter] = useState<"all" | TaskOwner>("all");
  const [query, setQuery] = useState("");
  const [showNew, setShowNew] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Render only after mount: browser extensions (Dashlane etc.) mutate form HTML
  // before React hydrates, which trips hydration warnings. Client-only sidesteps it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Viewing a board IS selecting that environment — keep the global switcher
  // (and every other project-scoped page) in sync with the board you opened.
  const { setCurrentId } = useProject();
  useEffect(() => {
    if (projectId) setCurrentId(projectId);
  }, [projectId, setCurrentId]);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const refresh = useCallback(async (pid?: string) => {
    if (!pid) return;
    try {
      setTasks(await brokk.listTasks(pid));
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const projects = await brokk.listProjects();
        if (!alive) return;
        const p = (projectId ? projects.find((x) => x.id === projectId) : projects[0]) ?? null;
        setProject(p);
        await refresh(p?.id);
      } catch (e) {
        setErr(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, refresh]);

  useEffect(() => {
    if (!project?.id) return;
    const i = setInterval(() => refresh(project.id), 3000);
    return () => clearInterval(i);
  }, [project?.id, refresh]);

  // Load the most-recent active preview when the project becomes known.
  useEffect(() => {
    if (!project?.id) return;
    brokk
      .listPreviews(project.id)
      .then((ps) => {
        const active = ps.find((x) => x.status === "starting" || x.status === "live");
        setPreview(active ?? null);
      })
      .catch(() => {});
  }, [project?.id]);

  // Poll the preview status every 2 s while it is still starting.
  const previewId = preview?.id;
  const previewStatus = preview?.status;
  useEffect(() => {
    if (!previewId || previewStatus !== "starting") return;
    const id = previewId;
    const i = setInterval(() => {
      brokk.getPreview(id).then(setPreview).catch(() => {});
    }, 2000);
    return () => clearInterval(i);
  }, [previewId, previewStatus]);

  async function handlePreview() {
    if (!project) return;
    setPreviewBusy(true);
    setPreviewErr(null);
    try {
      const pv = await brokk.createPreview({ projectId: project.id });
      setPreview(pv);
    } catch (e) {
      setPreviewErr(String(e));
    } finally {
      setPreviewBusy(false);
    }
  }

  async function handleStopPreview() {
    if (!preview) return;
    // Failed previews are just dismissed locally; live/starting ones are stopped via API.
    if (preview.status === "failed") {
      setPreview(null);
      return;
    }
    try {
      await brokk.stopPreview(preview.id);
      setPreview(null);
    } catch (e) {
      setPreviewErr(String(e));
    }
  }

  // Create a manual card. owner='brokk' + queue → straight to the forge; owner
  // ='human' → it stays a backlog card you own (the runner never claims it).
  const handleCreate = useCallback(
    async (input: { title: string; body: string; owner: TaskOwner; queue: boolean }) => {
      if (!project) return;
      const task = await brokk.createTask({
        projectId: project.id,
        title: input.title,
        body: input.body,
        owner: input.owner,
      });
      if (input.owner === "brokk" && input.queue) await brokk.enqueueTask(task.id);
      await refresh(project.id);
    },
    [project, refresh, toast],
  );

  // Keyboard: `c` opens the new-card modal, `/` focuses search — the Linear feel.
  // Ignored while typing in a field or when a modal/drawer already owns focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (showNew || selected) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(input|textarea|select)$/i.test(el.tagName)) return;
      if (e.key === "c") {
        e.preventDefault();
        setShowNew(true);
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showNew, selected]);

  // Queue an ALREADY-ANALYSED card: approve its Resolve analysis (atomic → enqueue,
  // feature → spawn sub-cards). Backlog cards can't queue directly — they must be
  // analysed first, so the queue action only lives on cards in the Analysis column.
  async function approveAndQueue(id: string) {
    try {
      await brokk.approveAnalysis(id);
      await refresh(project?.id);
      toast("Queued — to the forge.", { tone: "ok" });
    } catch {
      // #5: the analysis isn't ready yet (or needs the confirm-questions flow) —
      // open the drawer where the analysis + Aprovar live, instead of a bare error.
      setSelected(id);
    }
  }

  // Mark a card done from the ⋯ menu = resolve it by hand (same meaning as the
  // drawer's "Resolver por fora", #10): done + owner=human + a `resolved` event.
  // Optimistic: move to Done now, then persist + reconcile.
  const markCardDone = useCallback(
    async (id: string) => {
      setTasks((prev) =>
        prev.map((x) => (x.id === id ? { ...x, status: "done", owner: "human" } : x)),
      );
      try {
        await brokk.resolveTask(id, "concluído pelo menu do card");
        toast("Marked done.", { tone: "ok" });
      } catch (e) {
        toast("Could not resolve the card.", { meta: String(e), tone: "err" });
      }
      await refresh(project?.id);
    },
    [project, refresh],
  );

  // Kick Resolve on a card — moves it into the Analysis column and opens the drawer
  // so you can watch the plan land.
  async function analyze(id: string) {
    try {
      await analysisApi.scout(id);
      setSelected(id);
      await refresh(project?.id);
    } catch (e) {
      setErr(String(e));
    }
  }

  const selectedTask = tasks.find((x) => x.id === selected) ?? null;

  // Owner lane + free-text filter, applied to both the board and the list.
  const q = query.trim().toLowerCase();
  const visible = tasks.filter(
    (x) =>
      (ownerFilter === "all" || x.owner === ownerFilter) &&
      (!q || x.title.toLowerCase().includes(q) || (x.body ?? "").toLowerCase().includes(q)),
  );
  const mineCount = tasks.filter((x) => x.owner === "human").length;

  if (!mounted) return null;

  return (
    <Main style={{ maxWidth: "94rem" }}>
      <header className="forge-head">
        <Link href="/fleet" className="forge-crumb">
          ← Fleet
        </Link>
        <div className="forge-head-top">
          <div>
            <span className="forge-eyebrow">Brokk · the anvil</span>
            <h1 className="forge-title">{project ? project.name : "Board"}</h1>
            <p className="forge-sub">
              Card → agent → PR.{" "}
              {project && <span className="ygg-dim">model {project.model}</span>}
            </p>
          </div>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {project && (
              <Button size="sm" type="button" onClick={() => setShowNew(true)}>
                <Plus size={14} style={{ marginRight: 4, verticalAlign: "-2px" }} />
                New card
              </Button>
            )}
            {project &&
              (preview && preview.status !== "stopped" ? (
                <PreviewChip preview={preview} onStop={handleStopPreview} />
              ) : (
                <Button variant="outline" size="sm" type="button" onClick={handlePreview} disabled={previewBusy}>
                  {previewBusy ? "Starting…" : "Preview dev"}
                </Button>
              ))}
          </span>
        </div>
        <div className="forge-head-rule" />
      </header>

      {/* Toolbar: search + owner lane filter + view toggle — the "ver todos os
          cards facilmente" surface. */}
      <div style={toolbar}>
        <div style={{ position: "relative", flex: "1 1 240px", minWidth: 0 }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: t.textFaint }} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cards…  ( / )"
            style={{ ...field, width: "100%", paddingLeft: 30 }}
          />
        </div>
        <div style={segGroup}>
          {(["all", "brokk", "human"] as const).map((o) => (
            <button key={o} type="button" onClick={() => setOwnerFilter(o)} style={segBtn(ownerFilter === o)}>
              {o === "all" ? "All" : o === "brokk" ? "Brokk" : `Mine${mineCount ? ` (${mineCount})` : ""}`}
            </button>
          ))}
        </div>
        <div style={segGroup}>
          <button type="button" onClick={() => setView("board")} style={segBtn(view === "board")} aria-label="Board" title="Board">
            <Columns3 size={15} />
          </button>
          <button type="button" onClick={() => setView("list")} style={segBtn(view === "list")} aria-label="List" title="List">
            <Rows3 size={15} />
          </button>
        </div>
      </div>

      {err && <Banner tone="err">{err}</Banner>}
      {previewErr && <Banner tone="err">Preview failed: {previewErr}</Banner>}

      {view === "board" ? (
        visible.length === 0 ? (
          <div className="forge-empty is-panel">
            <span className="forge-empty-title">Nothing on the anvil</span>
            <p className="forge-empty-sub">
              {query || ownerFilter !== "all"
                ? "Nothing matches this filter. Clear it, or queue work from the composer."
                : "Queue work from Fleet, the composer, or New card — it lines up here by stage."}
            </p>
          </div>
        ) : (
        <div className="anvil-board">
          {COLUMNS.map((key) => {
            const items = visible.filter((x) => x.status === key);
            return (
              <section key={key} className="anvil-col">
                <div className="forge-h" style={{ margin: "0 0 0.7rem" }}>
                  <span className="forge-h-title">{STATUS_LABEL[key]}</span>
                  <span className="forge-h-meta">{items.length}</span>
                  <span className="forge-h-rule" />
                </div>
                <div className="anvil-cards">
                  {items.length === 0 && <div className="anvil-col-empty" aria-hidden>—</div>}
                  {items.map((task) => (
                    <div
                      key={task.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelected(task.id)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(task.id); } }}
                      className={`anvil-card${selected === task.id ? " is-selected" : ""}${task.status === "running" ? " is-running" : ""}`}
                    >
                      <span className="anvil-card-head">
                        <span className="anvil-card-lead">
                          <span className="anvil-card-dot" style={{ background: task.status === "running" ? "var(--ember)" : STATUS_COLOR[task.status] }} />
                          <span className="anvil-card-title">{task.title}</span>
                        </span>
                        <CardMenu task={task} onMarkDone={markCardDone} />
                      </span>
                      <span className="anvil-card-foot">
                        <OwnerChip owner={task.owner} source={task.source} />
                        <span style={{ flex: 1 }} />
                        {task.status === "backlog" && (
                          <span onClick={(e) => { e.stopPropagation(); analyze(task.id); }} className="anvil-card-act" style={{ "--act": STATUS_COLOR.analysis } as React.CSSProperties}>
                            Analyze →
                          </span>
                        )}
                        {/* Queue only for already-analysed cards (owner=brokk). Backlog
                            must go through analyze first. */}
                        {task.status === "analysis" && task.owner === "brokk" && (
                          <span onClick={(e) => { e.stopPropagation(); approveAndQueue(task.id); }} className="anvil-card-act">
                            Queue →
                          </span>
                        )}
                        {task.prUrl && (
                          <a href={task.prUrl} target="_blank" rel="noreferrer" className="anvil-card-pr" onClick={(e) => e.stopPropagation()}>
                            PR ↗
                          </a>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
        )
      ) : (
        <ListView tasks={visible} selected={selected} onSelect={setSelected} onMarkDone={markCardDone} />
      )}

      {selectedTask && (
        <Detail
          task={selectedTask}
          onClose={() => setSelected(null)}
          onChanged={() => refresh(project?.id)}
        />
      )}

      {showNew && project && (
        <NewCardModal
          onClose={() => setShowNew(false)}
          onCreate={handleCreate}
        />
      )}
    </Main>
  );
}

/** Owner/source signal chip. 'human' reads as "Mine" (you pulled it); manual cards
 *  get a subtle "manual" hint. Brokk-owned agent cards show nothing (the default). */
function OwnerChip({ owner, source }: { owner: TaskOwner; source: string }) {
  if (owner === "human") {
    return (
      <span style={ownerChip(STATUS_COLOR.review)}>
        <UserIcon size={11} /> Mine
      </span>
    );
  }
  if (source === "manual") {
    return <span style={ownerChip(t.textFaint)}>manual</span>;
  }
  return null;
}

/** List view — a flat, scannable table of every (filtered) card, grouped nowhere,
 *  sorted by status order then recency. The Linear "see everything at once" mode. */
function ListView({
  tasks,
  selected,
  onSelect,
  onMarkDone,
}: {
  tasks: Task[];
  selected: string | null;
  onSelect: (id: string) => void;
  onMarkDone: (id: string) => void;
}) {
  const order = COLUMNS as readonly string[];
  const rows = [...tasks].sort(
    (a, b) =>
      order.indexOf(a.status) - order.indexOf(b.status) ||
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
  if (rows.length === 0)
    return (
      <div className="forge-empty">
        <p className="forge-empty-sub">Nothing matches this filter. Clear it, or queue work from the composer.</p>
      </div>
    );
  return (
    <div className="forge-ledger">
      {rows.map((task) => (
        <div
          key={task.id}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(task.id)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(task.id); } }}
          className={`forge-row${task.status === "running" ? " is-running" : ""}`}
          style={{ cursor: "pointer", ...(selected === task.id ? { background: "color-mix(in srgb, var(--accent) 8%, var(--panel))" } : null) }}
        >
          <span style={{ ...dot, background: task.status === "running" ? "var(--ember)" : STATUS_COLOR[task.status], marginTop: 0 }} />
          <span className={chipClass(task.status)} style={{ flexShrink: 0, minWidth: 76, justifyContent: "center" }}>
            {task.status}
          </span>
          <span className="forge-row-title">{task.title}</span>
          <OwnerChip owner={task.owner} source={task.source} />
          {task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noreferrer" style={prLink} onClick={(e) => e.stopPropagation()}>
              PR ↗
            </a>
          )}
          <CardMenu task={task} onMarkDone={onMarkDone} />
        </div>
      ))}
    </div>
  );
}

/** Per-card overflow (⋯) menu. Starts with "Marcar como concluído" (moves the card
 *  to the Done column via a plain status transition — logged on the trail like any
 *  other move). Built to grow: add more items as the card actions expand. Uses a
 *  fixed-positioned popover computed from the button rect so the column's overflow
 *  never clips it. */
function CardMenu({ task, onMarkDone }: { task: Task; onMarkDone: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, right: 8 });
  const btnRef = useRef<HTMLButtonElement>(null);

  // #7: the popover is fixed at click-time coords, so if the board scrolls (or the
  // layout shifts) while it's open it would detach and float over another card.
  // Re-pin it to its button on scroll/resize instead of closing — closing on every
  // scroll misfires under the column's scroll-snap. Close only if the button leaves
  // the viewport.
  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
        setOpen(false);
        return;
      }
      setCoords({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setCoords({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    setOpen((o) => !o);
  }

  function markDone(e: React.MouseEvent) {
    e.stopPropagation();
    setOpen(false);
    if (canMarkDone) onMarkDone(task.id);
  }

  const isDone = task.status === "done";
  // #6: a running card has a live forge run — force-marking it done races the
  // runner (which will flip it back on completion), so the action is disabled.
  const isRunning = task.status === "running";
  const canMarkDone = !isDone && !isRunning;
  const doneLabel = isDone
    ? "Already done"
    : isRunning
      ? "In the fire — wait"
      : "Mark done";
  return (
    <>
      <button ref={btnRef} type="button" aria-label="Card actions" onClick={toggle} style={menuBtn}>
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <>
          {/* Full-screen backdrop closes the menu on any outside click — no document
              listeners, so a click on a menu item can never be swallowed by a close. */}
          <div style={menuBackdrop} onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div style={{ ...menuPopover, top: coords.top, right: coords.right }} onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={markDone} disabled={!canMarkDone} style={menuItem(!canMarkDone)}>
              <CheckCircle2 size={13} style={{ color: STATUS_COLOR.done }} />
              {doneLabel}
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** The "adicionar card manual" modal. Choose who drives it: Brokk (flows to the
 *  forge) or you (a card you'll resolve yourself — the runner never claims it). */
function NewCardModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: { title: string; body: string; owner: TaskOwner; queue: boolean }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [owner, setOwner] = useState<TaskOwner>("brokk");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await onCreate({ title: title.trim(), body: body.trim(), owner, queue: true });
      onClose();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>New card</h2>
          <Button variant="outline" size="icon" onClick={onClose} aria-label="Close">✕</Button>
        </div>
        {err && <Banner tone="err">{err}</Banner>}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title…"
          // biome-ignore lint/a11y/noAutofocus: modal opened on explicit action
          autoFocus
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && submit()}
          style={{ ...field, width: "100%", marginBottom: 8 }}
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What needs doing…"
          rows={4}
          style={{ ...field, width: "100%", resize: "vertical", marginBottom: 14 }}
        />
        <div className="ygg-dim" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 7 }}>
          Who forges it
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          <button type="button" onClick={() => setOwner("brokk")} style={ownerPick(owner === "brokk")}>
            <Bot size={16} />
            <span style={{ fontWeight: 600, fontSize: 13 }}>Brokk</span>
            <span className="ygg-dim" style={{ fontSize: 11 }}>goes to the forge queue</span>
          </button>
          <button type="button" onClick={() => setOwner("human")} style={ownerPick(owner === "human")}>
            <UserIcon size={16} />
            <span style={{ fontWeight: 600, fontSize: 13 }}>Me</span>
            <span className="ygg-dim" style={{ fontSize: 11 }}>stays yours — the runner skips it</span>
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !title.trim()}>
            {busy ? "Creating…" : owner === "brokk" ? "Create → queue" : "Create card"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Detail({ task, onClose, onChanged }: { task: Task; onClose: () => void; onChanged: () => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const isAnalysis = task.status === "analysis";
  const isTerminal = task.status === "done" || task.status === "cancelled";
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffErr, setHandoffErr] = useState<string | null>(null);

  async function handoff(fn: () => Promise<unknown>) {
    setHandoffBusy(true);
    setHandoffErr(null);
    try {
      await fn();
      onChanged();
      onClose();
    } catch (e) {
      setHandoffErr(String(e));
      setHandoffBusy(false);
    }
  }

  useEffect(() => {
    // A card in analysis has no runs yet — its drawer is the plan, not the log.
    if (isAnalysis) return;
    let unsub: (() => void) | undefined;
    setEvents([]);
    (async () => {
      const rs = await brokk.listTaskRuns(task.id).catch(() => [] as Run[]);
      setRuns(rs);
      const latest = rs[0];
      if (latest) unsub = brokk.streamRunEvents(latest.id, (e) => setEvents((prev) => [...prev, e]));
    })();
    return () => unsub?.();
  }, [task.id, isAnalysis]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events]);

  const latest = runs[0];

  return (
    <div style={overlay} onClick={onClose}>
      <aside style={drawer} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>{task.title}</h2>
          <Button variant="outline" size="icon" onClick={onClose} aria-label="Close">✕</Button>
        </div>
        <div style={{ display: "flex", gap: 8, margin: "8px 0 14px", alignItems: "center", flexWrap: "wrap" }}>
          <span className={chipClass(task.status)}>{task.status}</span>
          {latest && <span className={chipClass(latest.status)}>run {latest.status}</span>}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg-dim)" }}>
            by <AgentAvatar createdBy={task.createdBy} size={18} showLabel />
          </span>
          {task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noreferrer" style={{ ...prLink, position: "static" }}>
              Open PR ↗
            </a>
          )}
        </div>
        {task.body && <p className="ygg-muted" style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{task.body}</p>}
        {latest?.error && <pre style={{ ...logBox, color: STATUS_COLOR.failed, maxHeight: 120 }}>{latest.error}</pre>}

        {/* Handoff: pull the card out of the forge, hand it back, or mark it
            resolved by hand. The "resolver independente do Brokk" surface. */}
        <div style={handoffBar}>
          {task.owner === "brokk" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={handoffBusy}
              onClick={() => handoff(() => brokk.setTaskOwner(task.id, "human", "pego pelo humano"))}
            >
              <Hand size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />
              Take it
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={handoffBusy}
              onClick={() => handoff(() => brokk.setTaskOwner(task.id, "brokk", "devolvido ao forge"))}
            >
              <Undo2 size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />
              Return to Brokk
            </Button>
          )}
          {!isTerminal && (
            <Button
              size="sm"
              disabled={handoffBusy}
              onClick={() => handoff(() => brokk.resolveTask(task.id, "resolvido fora do forge"))}
            >
              <CheckCircle2 size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />
              Resolve by hand
            </Button>
          )}
        </div>
        {handoffErr && <Banner tone="err">{handoffErr}</Banner>}

        {isAnalysis ? (
          <AnalysisPanel task={task} onChanged={onChanged} onClose={onClose} />
        ) : (
          <>
            <h3 className="ygg-muted" style={{ fontSize: 12, textTransform: "uppercase", margin: "16px 0 8px" }}>
              Live run log{latest && <> · <span className="forge-row-mono">{latest.id.slice(0, 8)}</span></>}
            </h3>
            <RunLog events={events} logRef={logRef} />
          </>
        )}

        <Timeline taskId={task.id} status={task.status} owner={task.owner} />
      </aside>
    </div>
  );
}

/** The card's lifecycle trail — the "rastreio completo de ciclo de vida". Reads
 *  task_events and renders who moved the card, when, and why. Re-fetched when the
 *  card's status/owner changes so a fresh transition shows without a reopen. */
function Timeline({ taskId, status, owner }: { taskId: string; status: string; owner: string }) {
  const [events, setEvents] = useState<TaskEvent[] | null>(null);
  useEffect(() => {
    let alive = true;
    brokk
      .listTaskEvents(taskId)
      .then((e) => alive && setEvents(e))
      .catch(() => alive && setEvents([]));
    return () => {
      alive = false;
    };
    // status/owner in deps → the trail refreshes after a transition or handoff.
  }, [taskId, status, owner]);

  return (
    <div style={{ marginTop: 20 }}>
      <h3 className="ygg-muted" style={{ fontSize: 12, textTransform: "uppercase", margin: "0 0 10px", letterSpacing: 0.4 }}>
        Lifecycle
      </h3>
      {events === null ? (
        <p className="ygg-dim" style={{ fontSize: 12 }}>Loading…</p>
      ) : events.length === 0 ? (
        <p className="ygg-dim" style={{ fontSize: 12 }}>No events yet.</p>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 0 }}>
          {events.map((ev, i) => (
            <li key={ev.id} style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 10 }}>
                <span style={{ ...dot, marginTop: 5, background: eventTint(ev) }} />
                {i < events.length - 1 && <span style={{ flex: 1, width: 1, background: t.border, marginTop: 2 }} />}
              </div>
              <div style={{ paddingBottom: 12, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: t.text }}>
                  {eventLabel(ev)}
                </div>
                <div className="ygg-dim" style={{ fontSize: 11, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                  {ev.actor} · {new Date(ev.at).toLocaleString()}
                  {ev.reason ? ` · ${ev.reason}` : ""}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function eventTint(ev: TaskEvent): string {
  if (ev.type === "owner") return ev.to === "human" ? STATUS_COLOR.review : STATUS_COLOR.backlog;
  if (ev.type === "created") return STATUS_COLOR.backlog;
  return STATUS_COLOR[ev.to ?? ""] ?? t.textFaint;
}

function eventLabel(ev: TaskEvent): string {
  switch (ev.type) {
    case "created":
      return `Card created (${ev.to})`;
    case "owner":
      return ev.to === "human" ? "Taken by a human" : "Returned to Brokk";
    case "resolved":
      return "Resolved by hand";
    case "status":
      return `${ev.from ?? "—"} → ${ev.to}`;
    default:
      return ev.reason ?? ev.type;
  }
}

/** The Analysis drawer — Resolve's "visão pra resolução". Polls the card's analysis
 *  while the scout runs, then renders the plan: approach + rationale, the ordered
 *  steps (with the files each touches), and the open questions. Questions get an
 *  answer box that re-runs Resolve; "Aprovar" enqueues (atomic) or spawns the
 *  sub-cards (feature). */
function AnalysisPanel({ task, onChanged, onClose }: { task: Task; onChanged: () => void; onClose: () => void }) {
  const [analysis, setAnalysis] = useState<TaskAnalysis | null>(null);
  const [running, setRunning] = useState(false);
  const [detailsInput, setDetailsInput] = useState("");
  const [busy, setBusy] = useState<null | "approve" | "reanalyze" | "details">(null);
  const [err, setErr] = useState<string | null>(null);
  // Non-technical-first: the plain summary + premises lead; the technical detail
  // (rationale + per-step internals) starts collapsed behind a toggle, and each
  // step expands on demand. History is opt-in too.
  const [showTech, setShowTech] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [openSteps, setOpenSteps] = useState<Record<number, boolean>>({});

  // Poll the analysis while a scout is in flight (or the row is still pending).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await analysisApi.get(task.id);
        if (!alive) return;
        setAnalysis(r.analysis);
        setRunning(r.running || r.analysis?.status === "pending");
      } catch {
        /* transient — keep polling */
      }
    };
    tick();
    const i = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [task.id]);

  async function approve() {
    setBusy("approve");
    setErr(null);
    try {
      await brokk.approveAnalysis(task.id);
      onChanged();
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  // `composed` = the human's per-question answers, folded into one string by
  // ConfirmQuestions. Empty = a bare re-run (retry / re-plan without new input).
  async function reanalyze(composed = "") {
    setBusy("reanalyze");
    setErr(null);
    try {
      await analysisApi.answer(task.id, composed.trim());
      setRunning(true);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  // "Adicionar Detalhes": new authoritative info → a full v+1 (title/citations/
  // details/plan), with the prior version snapshotted into history.
  async function addDetails() {
    if (!detailsInput.trim()) return;
    setBusy("details");
    setErr(null);
    try {
      await analysisApi.addDetails(task.id, detailsInput.trim());
      setDetailsInput("");
      setRunning(true);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  const pending = running || analysis?.status === "pending" || !analysis;
  const failed = analysis?.status === "failed";

  return (
    <div style={{ marginTop: 16 }}>
      <h3 className="ygg-muted" style={{ fontSize: 12, textTransform: "uppercase", margin: "0 0 10px", letterSpacing: 0.4 }}>
        Resolve · the plan
      </h3>

      {err && <Banner tone="err">{err}</Banner>}

      {pending && !failed && (
        <p className="ygg-dim" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ ...dot, background: STATUS_COLOR.analysis, marginTop: 0 }} />
          Reading the checkout, drafting the plan…
        </p>
      )}

      {failed && (
        <>
          <pre style={{ ...logBox, color: STATUS_COLOR.failed, maxHeight: 140 }}>{analysis?.error ?? "Analysis failed — no detail returned."}</pre>
          <Button size="sm" variant="outline" onClick={() => reanalyze()} disabled={busy !== null} style={{ marginTop: 10 }}>
            {busy === "reanalyze" ? "Reanalyzing…" : "Retry"}
          </Button>
        </>
      )}

      {analysis?.status === "ready" && (() => {
        const needsConfirm = analysis.questions.length > 0;
        const isFeature = analysis.mode === "feature";
        const titleChanged = !!analysis.revisedTitle && analysis.revisedTitle !== task.title;
        const problem = analysis.details || analysis.approach;
        return (
        <>
          {/* Sinais em destaque: versão + escopo + confiança (das premissas em aberto). */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <span className="ygg-badge">v{analysis.version}</span>
            <span className="ygg-badge" data-tone={isFeature ? "warn" : "ok"}>
              {isFeature ? `feature · ${analysis.steps.length} sub-cards` : "atomic · 1 PR"}
            </span>
            <span className="ygg-badge" data-tone={needsConfirm ? "warn" : "ok"}>
              {needsConfirm
                ? `${analysis.questions.length} assumption${analysis.questions.length === 1 ? "" : "s"} to confirm`
                : "0 open questions"}
            </span>
          </div>

          {/* Título corrigido — destaque: conserta a moldura enganosa que veio do card. */}
          {titleChanged && (
            <div style={{ ...calloutBox, borderColor: `${STATUS_COLOR.analysis}66`, borderLeftColor: STATUS_COLOR.analysis }}>
              <div className="ygg-dim" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
                Title revised
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>{analysis.revisedTitle}</div>
              <div className="ygg-dim" style={{ fontSize: 11, marginTop: 4, textDecoration: "line-through" }}>{task.title}</div>
              <div className="ygg-dim" style={{ fontSize: 11, marginTop: 3 }}>replaces the card title on approve</div>
            </div>
          )}

          {/* O problema em linguagem simples — a "manchete", pra qualquer pessoa entender. */}
          {problem && (
            <p style={{ fontSize: 15, lineHeight: 1.5, margin: "0 0 6px", fontWeight: 500 }}>{problem}</p>
          )}
          <p className="ygg-dim" style={{ fontSize: 12.5, margin: "0 0 14px" }}>
            {isFeature
              ? `Larger job — becomes ${analysis.steps.length} sub-cards, in order.`
              : "Localized change — becomes one PR."}
          </p>

          {/* Citações da reunião — verbatim, rastreabilidade real. */}
          {analysis.evidence.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div className="ygg-dim" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
                From the meeting
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {analysis.evidence.map((ev, i) => (
                  <blockquote key={i} style={quoteBox}>
                    <span style={{ fontSize: 13, lineHeight: 1.45, fontStyle: "italic" }}>“{ev.quote}”</span>
                    {(ev.speaker || ev.note) && (
                      <div className="ygg-dim" style={{ fontSize: 11, marginTop: 3 }}>
                        {ev.speaker ? `— ${ev.speaker}` : ""}
                        {ev.speaker && ev.note ? " · " : ""}
                        {ev.note ?? ""}
                      </div>
                    )}
                  </blockquote>
                ))}
              </div>
            </div>
          )}

          {/* Premissas a confirmar — elevado acima do técnico: é o que mais importa
              pro humano decidir (o seam de "não consigo julgar isso pelo código").
              Pergunta-a-pergunta: 2 caminhos + "Outro"; responde todas → re-analisa. */}
          {needsConfirm && (
            <ConfirmQuestions
              key={analysis.version}
              questions={analysis.questions}
              busy={busy === "reanalyze"}
              onSubmit={(composed) => reanalyze(composed)}
            />
          )}

          {/* Detalhes técnicos — colapsados por padrão (não-técnico primeiro). */}
          <button type="button" onClick={() => setShowTech((v) => !v)} style={techToggle}>
            <span>{showTech ? "▾" : "▸"} Technical detail</span>
            <span className="ygg-dim" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, fontVariantNumeric: "tabular-nums" }}>
              {analysis.steps.length} step{analysis.steps.length === 1 ? "" : "s"}
            </span>
          </button>

          {showTech && (
            <div style={{ marginTop: 10 }}>
              {analysis.rationale && (
                <p className="ygg-muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: "0 0 12px" }}>
                  {analysis.rationale}
                </p>
              )}
              <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
                {analysis.steps.map((s, i) => {
                  const open = !!openSteps[i];
                  return (
                    <li key={i} style={stepCard}>
                      <button
                        type="button"
                        onClick={() => setOpenSteps((m) => ({ ...m, [i]: !m[i] }))}
                        style={stepHead}
                      >
                        <span style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
                          <span className="ygg-dim" style={{ fontVariantNumeric: "tabular-nums" }}>{i + 1}.</span>
                          <span style={{ fontWeight: 600, fontSize: 13, minWidth: 0, wordBreak: "break-word" }}>{s.title}</span>
                        </span>
                        <span className="ygg-dim" style={{ fontSize: 11, flexShrink: 0, marginLeft: 8 }}>
                          {s.touches.length > 0 ? `${s.touches.length} file${s.touches.length === 1 ? "" : "s"} ` : ""}{open ? "▾" : "▸"}
                        </span>
                      </button>
                      {open && (
                        <div style={{ padding: "0 11px 11px" }}>
                          {s.detail && (
                            <div className="ygg-muted" style={{ fontSize: 12.5, lineHeight: 1.45, marginBottom: 6 }}>{s.detail}</div>
                          )}
                          {s.touches.length > 0 && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
                              {s.touches.map((f) => (
                                <code key={f} style={touchChip}>{f}</code>
                              ))}
                            </div>
                          )}
                          {s.acceptance && <div className="ygg-dim" style={{ fontSize: 11.5 }}>✓ {s.acceptance}</div>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {/* Adicionar Detalhes — sempre disponível: injeta info nova e autoritativa
              (o que a IA não pôde saber), regenerando título/citações/plano numa v+1. */}
          <div style={{ marginTop: 16, borderTop: `1px solid ${t.border}`, paddingTop: 12 }}>
            <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, color: t.textMuted, fontWeight: 600, marginBottom: 8 }}>
              Add details
            </div>
            <textarea
              value={detailsInput}
              onChange={(e) => setDetailsInput(e.target.value)}
              placeholder="Know something the plan doesn't? Write it — title, quotes, and plan regenerate."
              rows={3}
              style={{ ...field, width: "100%", resize: "vertical", minWidth: 0 }}
            />
            <Button size="sm" variant="outline" onClick={addDetails} disabled={busy !== null || !detailsInput.trim()} style={{ marginTop: 8 }}>
              {busy === "details" ? "Revising…" : `Revise → v${analysis.version + 1}`}
            </Button>
          </div>

          {/* Histórico de versões — a linhagem v1 → v2 → … */}
          {analysis.revisions.length > 0 && (
            <>
              <button type="button" onClick={() => setShowHistory((v) => !v)} style={techToggle}>
                <span>{showHistory ? "▾" : "▸"} History</span>
                <span className="ygg-dim" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, fontVariantNumeric: "tabular-nums" }}>
                  {analysis.revisions.length} prior version{analysis.revisions.length === 1 ? "" : "s"}
                </span>
              </button>
              {showHistory && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                  {[...analysis.revisions].reverse().map((r, i) => (
                    <div key={i} style={stepCard}>
                      <div style={{ padding: "9px 11px" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                          <span className="ygg-badge">v{r.version}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0, wordBreak: "break-word" }}>
                            {r.title ?? task.title}
                          </span>
                        </div>
                        {r.inputDetails && (
                          <div className="ygg-dim" style={{ fontSize: 11.5, marginTop: 5 }}>
                            + detail: {r.inputDetails}
                          </div>
                        )}
                        {r.details && (
                          <div className="ygg-muted" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>{r.details}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Ações. Com premissas em aberto, Aprovar vira secundário — o CTA primário
              é responder+re-analisar (no callout acima). */}
          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            <Button onClick={approve} disabled={busy !== null} variant={needsConfirm ? "outline" : undefined}>
              {busy === "approve"
                ? "Approving…"
                : needsConfirm
                  ? (isFeature ? "Approve anyway → sub-cards" : "Approve anyway → queue")
                  : (isFeature ? "Approve → sub-cards" : "Approve → queue")}
            </Button>
            {!needsConfirm && (
              <Button variant="outline" onClick={() => reanalyze()} disabled={busy !== null}>
                {busy === "reanalyze" ? "…" : "Reanalyze"}
              </Button>
            )}
          </div>
        </>
        );
      })()}
    </div>
  );
}

// ── Live run log — a legible activity feed (icons + per-type treatment, à la
// Sindri). The forge emits typed RunEvents; we render assistant narration, tool
// calls (paired with their result), phase pills, and verify output — not raw
// `message [tool_use]` lines. Tools come from message content blocks (always
// present); standalone tool_use events are deduped by id; tool_result events
// supply the pairing. ──────────────────────────────────────────────────────────

type ToolBlock = { id?: string; name?: string; input?: Record<string, unknown> };
type ToolResultP = { tool_use_id?: string; ok?: boolean; preview?: string };

/** Tool name → friendly verb + icon (mirrors Sindri's TOOL_META). */
const TOOL_META: { match: RegExp; label: string; Icon: typeof Wrench }[] = [
  { match: /write|edit|str_replace|create|apply|patch/i, label: "Editing", Icon: FileEdit },
  { match: /read|cat|view|get_file/i, label: "Reading", Icon: FileText },
  { match: /bash|shell|run|exec|command|terminal/i, label: "Shell", Icon: TerminalSquare },
  { match: /pr|pull|merge|commit|push|branch|git/i, label: "Git", Icon: GitPullRequest },
  { match: /card|task|plan|todo/i, label: "Planning", Icon: ListTodo },
];
function toolMeta(name = "") {
  return TOOL_META.find((t) => t.match.test(name)) ?? { label: "Tool", Icon: Wrench };
}

/** Friendly phase label + tint + icon for a `status` event. Null = don't show. */
function phaseMeta(p: Record<string, unknown>): { label: string; tint: string; Icon: typeof Wrench } | null {
  switch (p.phase) {
    case "verify_start":
      return { label: p.round != null ? `Verifying (round ${p.round})…` : "Verifying…", tint: STATUS_COLOR.running, Icon: Loader2 };
    case "verify_done":
      return p.ok
        ? { label: "Verify passed", tint: STATUS_COLOR.done, Icon: CheckCircle2 }
        : { label: "Verify failed", tint: STATUS_COLOR.failed, Icon: XCircle };
    case "heal":
      return { label: `Fixing (attempt ${p.attempt}/${p.of})`, tint: STATUS_COLOR.queued, Icon: Loader2 };
    case "acceptance":
      return { label: "Live check…", tint: STATUS_COLOR.running, Icon: Loader2 };
    case "forge_pass":
      return { label: "Forge pass done", tint: t.textMuted, Icon: CheckCircle2 };
    case "agent_done":
      return { label: "Run finished", tint: t.textMuted, Icon: CheckCircle2 };
    default:
      return null; // agent_start etc. — noise, skip
  }
}

function RunLog({ events, logRef }: { events: RunEvent[]; logRef: React.RefObject<HTMLDivElement | null> }) {
  const resultById = new Map<string, ToolResultP>();
  for (const e of events) {
    if (e.type === "tool_result") {
      const p = e.payload as ToolResultP;
      if (p?.tool_use_id) resultById.set(p.tool_use_id, p);
    }
  }

  const items: React.ReactNode[] = [];
  events.forEach((e, i) => {
    const p = e.payload as any;
    if (e.type === "status") {
      const m = phaseMeta(p ?? {});
      if (m) items.push(<PhaseRow key={i} {...m} />);
      return;
    }
    if (e.type === "log") {
      const text = p?.verify ?? p?.error ?? (typeof p === "string" ? p : "");
      if (text) items.push(<LogRow key={i} error={p?.level === "error"} text={String(text)} />);
      return;
    }
    if (e.type === "acceptance") {
      items.push(<AcceptanceRow key={i} receipt={p ?? {}} />);
      return;
    }
    if (e.type === "message") {
      const c = p?.content ?? p?.message?.content;
      const blocks: any[] = Array.isArray(c) ? c : [];
      const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim();
      if (text) items.push(<TextRow key={`${i}-t`} text={text} />);
      blocks
        .filter((b) => b?.type === "tool_use")
        .forEach((b: ToolBlock, j) =>
          items.push(<ToolRow key={`${i}-${j}`} tool={b} result={b.id ? resultById.get(b.id) : undefined} />),
        );
    }
    // standalone tool_use / tool_result / usage: deduped/folded (rendered via message)
  });

  return (
    <div ref={logRef} style={runLogBox}>
      {items.length === 0 ? <span className="ygg-dim" style={{ fontSize: 12 }}>No events yet.</span> : items}
    </div>
  );
}

function TextRow({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <Brain size={14} style={{ color: t.purple, flexShrink: 0, marginTop: 2 }} />
      <div style={{ fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", minWidth: 0, color: t.text }}>
        {text}
      </div>
    </div>
  );
}

function PhaseRow({ label, tint, Icon }: { label: string; tint: string; Icon: typeof Wrench }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 0" }}>
      <Icon size={13} style={{ color: tint, flexShrink: 0 }} />
      <span style={{ fontSize: 11.5, fontWeight: 600, color: tint, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</span>
    </div>
  );
}

function ToolRow({ tool, result }: { tool: ToolBlock; result?: ToolResultP }) {
  const [open, setOpen] = useState(false);
  const { label, Icon } = toolMeta(tool.name);
  const input = tool.input ?? {};
  const arg =
    (input.command as string) || (input.file_path as string) || (input.path as string) || (input.title as string) || "";
  const status: "running" | "ok" | "error" = !result ? "running" : result.ok ? "ok" : "error";
  const pill = status === "running" ? STATUS_COLOR.running : status === "ok" ? STATUS_COLOR.done : STATUS_COLOR.failed;
  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 7, background: t.surface2, overflow: "hidden" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={toolRowHead}>
        <Icon size={13} style={{ color: t.textMuted, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, flexShrink: 0 }}>{label}</span>
        <code style={{ fontSize: 11, color: t.textFaint, fontFamily: "var(--font-mono, monospace)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}>
          {String(arg).slice(0, 100)}
        </code>
        {status === "running" ? (
          <Loader2 size={12} style={{ color: pill, flexShrink: 0 }} />
        ) : (
          <span style={{ fontSize: 10, fontWeight: 700, color: pill, flexShrink: 0, textTransform: "uppercase" }}>
            {status === "ok" ? "ok" : "err"}
          </span>
        )}
        <ChevronRight size={13} style={{ color: t.textFaint, flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }} />
      </button>
      {open && (
        <div style={{ padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
          <pre style={runPre}>{JSON.stringify(input, null, 2).slice(0, 2000)}</pre>
          {result?.preview && <pre style={{ ...runPre, color: result.ok ? t.textMuted : STATUS_COLOR.failed }}>{result.preview.slice(0, 2000)}</pre>}
        </div>
      )}
    </div>
  );
}

/** The "confirme antes de aprovar" seam, isolated per question. Each question
 *  offers Resolve's two answer paths + "Outro" (custom). The human answers every
 *  question; only then does "Iniciar re-análise" enable — it folds the answers
 *  into one string and hands it to the Resolve re-run. */
function ConfirmQuestions({
  questions,
  busy,
  onSubmit,
}: {
  questions: AnalysisQuestion[];
  busy: boolean;
  onSubmit: (answers: string) => void;
}) {
  // Chosen answer per question (option text OR the custom text). Empty = unanswered.
  const [picked, setPicked] = useState<Record<number, string>>({});
  // Which questions have the custom ("Outro") input revealed.
  const [customOpen, setCustomOpen] = useState<Record<number, boolean>>({});

  const answered = questions.filter((_, i) => (picked[i] ?? "").trim()).length;
  const allAnswered = answered === questions.length;

  const choose = (i: number, val: string) => {
    setPicked((p) => ({ ...p, [i]: val }));
    setCustomOpen((c) => ({ ...c, [i]: false }));
  };
  const openCustom = (i: number) => {
    setCustomOpen((c) => ({ ...c, [i]: true }));
    setPicked((p) => ({ ...p, [i]: "" }));
  };

  const submit = () =>
    onSubmit(questions.map((q, i) => `P: ${q.question}\nR: ${(picked[i] ?? "").trim()}`).join("\n\n"));

  return (
    <div style={calloutBox}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Confirm before approving</div>
      <div style={{ display: "grid", gap: 10 }}>
        {questions.map((q, i) => {
          const isCustom = customOpen[i];
          const sel = picked[i] ?? "";
          return (
            <div key={i} style={questionCard}>
              <div style={{ fontSize: 13, lineHeight: 1.45, marginBottom: 8, fontWeight: 500, color: t.text }}>
                {i + 1}. {q.question}
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                {q.options.map((opt, j) => (
                  <button key={j} type="button" onClick={() => choose(i, opt)} style={optionBtn(!isCustom && sel === opt)}>
                    {opt}
                  </button>
                ))}
                <button type="button" onClick={() => openCustom(i)} style={optionBtn(!!isCustom)}>
                  Other…
                </button>
                {isCustom && (
                  <textarea
                    value={sel}
                    onChange={(e) => setPicked((p) => ({ ...p, [i]: e.target.value }))}
                    placeholder="Your answer…"
                    rows={2}
                    // biome-ignore lint/a11y/noAutofocus: revealed on explicit click
                    autoFocus
                    style={{ ...field, width: "100%", resize: "vertical" }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
        <Button size="sm" onClick={submit} disabled={busy || !allAnswered}>
          {busy ? "Reanalyzing…" : "Reanalyze"}
        </Button>
        <span className="ygg-dim" style={{ fontSize: 11.5, fontVariantNumeric: "tabular-nums" }}>
          {answered}/{questions.length} answered
        </span>
      </div>
    </div>
  );
}

/** Live-acceptance receipt: pass/fail verdict + the check's output, and (when the
 *  check took one) the screenshot — the visual proof the change behaves. */
function AcceptanceRow({
  receipt,
}: {
  receipt: { ran?: boolean; ok?: boolean; output?: string; screenshot?: string };
}) {
  const [open, setOpen] = useState(false);
  if (!receipt?.ran) return null;
  const tint = receipt.ok ? STATUS_COLOR.done : STATUS_COLOR.failed;
  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 7, background: t.surface2, overflow: "hidden" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={toolRowHead}>
        <Camera size={13} style={{ color: tint, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: tint }}>
          Live check · {receipt.ok ? "passed" : "failed"}
        </span>
        <ChevronRight
          size={13}
          style={{ marginLeft: "auto", color: t.textMuted, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}
        />
      </button>
      {open && (
        <div style={{ padding: 10, borderTop: `1px solid ${t.border}`, display: "grid", gap: 8 }}>
          {receipt.screenshot && (
            <img
              src={receipt.screenshot}
              alt="acceptance screenshot"
              style={{ width: "100%", borderRadius: 6, border: `1px solid ${t.border}` }}
            />
          )}
          {receipt.output && (
            <pre style={{ fontSize: 11.5, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word", color: t.textMuted, margin: 0 }}>
              {receipt.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function LogRow({ text, error }: { text: string; error?: boolean }) {
  const [open, setOpen] = useState(!!error);
  return (
    <div style={{ border: `1px solid ${error ? `${STATUS_COLOR.failed}55` : t.border}`, borderRadius: 7, background: t.surface2, overflow: "hidden" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={toolRowHead}>
        <ScrollText size={13} style={{ color: error ? STATUS_COLOR.failed : t.textMuted, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, flex: 1, color: error ? STATUS_COLOR.failed : t.text }}>
          {error ? "Verify output (failed)" : "Log"}
        </span>
        <ChevronRight size={13} style={{ color: t.textFaint, flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }} />
      </button>
      {open && <pre style={{ ...runPre, margin: "0 10px 10px", color: error ? STATUS_COLOR.failed : t.textMuted }}>{text.slice(-3000)}</pre>}
    </div>
  );
}

const field: React.CSSProperties = {
  background: "var(--bg-soft)",
  border: "1px solid var(--line)",
  borderRadius: "0.55rem",
  padding: "0.55rem 0.7rem",
  color: "var(--fg)",
  font: "inherit",
  fontSize: "0.9rem",
  minWidth: 0,
  // border-box so `width: 100%` includes padding/border and never overflows its
  // container (the confirm callout / details box).
  boxSizing: "border-box",
};

// One confirmation question, isolated. `optionBtn(active)` = a full-width answer
// path; active highlights the chosen one (or the revealed "Outro").
const questionCard: React.CSSProperties = { border: `1px solid ${t.border}`, borderRadius: 8, background: t.surface, padding: "10px 12px" };
const optionBtn = (active: boolean): React.CSSProperties => ({
  width: "100%",
  textAlign: "left",
  fontSize: 12.5,
  lineHeight: 1.4,
  padding: "7px 10px",
  borderRadius: 7,
  cursor: "pointer",
  boxSizing: "border-box",
  border: `1px solid ${active ? STATUS_COLOR.analysis : t.border}`,
  background: active ? `${STATUS_COLOR.analysis}18` : t.surface2,
  color: active ? t.text : t.textMuted,
  fontWeight: active ? 600 : 400,
  transition: "background .12s, border-color .12s",
});

// Toolbar + segmented controls (search / owner lane / view toggle).
const toolbar: React.CSSProperties = { display: "flex", gap: 10, alignItems: "center", marginBottom: 16, flexWrap: "wrap" };
const segGroup: React.CSSProperties = { display: "flex", gap: 2, padding: 2, background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 8 };
const segBtn = (active: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 12.5,
  fontWeight: active ? 600 : 400,
  padding: "5px 11px",
  borderRadius: 6,
  border: "none",
  cursor: "pointer",
  background: active ? t.surface3 : "transparent",
  color: active ? t.text : t.textMuted,
});
const ownerChip = (color: string): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  fontSize: 10.5,
  fontWeight: 600,
  padding: "1px 7px",
  borderRadius: 20,
  border: `1px solid ${color}55`,
  color,
  background: `${color}14`,
  whiteSpace: "nowrap",
});
const modalCard: React.CSSProperties = { width: "min(520px, 100%)", margin: "auto", alignSelf: "center", background: t.bg, border: `1px solid ${t.border}`, borderRadius: 12, padding: 22, boxShadow: "var(--shadow-2)" };
const ownerPick = (active: boolean): React.CSSProperties => ({
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: 3,
  alignItems: "flex-start",
  textAlign: "left",
  padding: "11px 13px",
  borderRadius: 9,
  cursor: "pointer",
  border: `1px solid ${active ? t.borderActive : t.border}`,
  background: active ? t.surface3 : t.surface2,
  color: t.text,
});
const handoffBar: React.CSSProperties = { display: "flex", gap: 8, margin: "14px 0 4px", flexWrap: "wrap" };
// Per-card ⋯ menu: a flat icon button + a fixed-positioned popover (escapes the
// column's overflow clip).
const menuBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, flexShrink: 0, borderRadius: 6, border: "none", background: "transparent", color: t.textMuted, cursor: "pointer" };
const menuBackdrop: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 59 };
const menuPopover: React.CSSProperties = { position: "fixed", zIndex: 60, minWidth: 210, background: t.surface, border: `1px solid ${t.border}`, borderRadius: 9, padding: 5, boxShadow: "var(--shadow-2)", display: "flex", flexDirection: "column", gap: 2 };
const menuItem = (disabled: boolean): React.CSSProperties => ({ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "8px 10px", borderRadius: 6, border: "none", background: "transparent", color: disabled ? t.textFaint : t.text, fontSize: 12.5, cursor: disabled ? "default" : "pointer" });

const dot: React.CSSProperties = { width: 7, height: 7, borderRadius: 7, flexShrink: 0, marginTop: 5 };
const prLink: React.CSSProperties = { fontSize: 11, color: t.purple, textDecoration: "none" };
const touchChip: React.CSSProperties = { fontSize: 11, fontFamily: "var(--font-mono, monospace)", background: t.inset, border: `1px solid ${t.border}`, borderRadius: 5, padding: "1px 6px", color: t.textMuted };
const calloutBox: React.CSSProperties = { background: t.surface2, border: `1px solid ${STATUS_COLOR.queued}66`, borderLeft: `3px solid ${STATUS_COLOR.queued}`, borderRadius: 8, padding: "12px 14px", marginBottom: 16 };
const techToggle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", textAlign: "left", background: "transparent", border: "none", borderTop: `1px solid ${t.border}`, padding: "10px 0 2px", color: t.textMuted, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, cursor: "pointer" };
const stepCard: React.CSSProperties = { border: `1px solid ${t.border}`, borderRadius: 8, background: t.surface2, overflow: "hidden" };
const stepHead: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "transparent", border: "none", padding: "9px 11px", color: t.text, cursor: "pointer" };
const quoteBox: React.CSSProperties = { margin: 0, background: t.surface2, borderLeft: `3px solid ${t.border2}`, borderRadius: 6, padding: "8px 11px", color: t.text };
// Scrim + drawer shadow from tokens only — both themes read, nothing hardcoded.
const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "color-mix(in srgb, var(--bg) 62%, transparent)", display: "flex", justifyContent: "flex-end", zIndex: 50 };
const drawer: React.CSSProperties = { width: "min(560px, 100%)", height: "100%", background: t.bg, borderLeft: `1px solid ${t.border}`, padding: 22, overflowY: "auto", boxShadow: "var(--shadow-2)" };
const logBox: React.CSSProperties = { background: t.inset, border: `1px solid ${t.border}`, borderRadius: 8, padding: 10, fontFamily: "var(--font-mono, monospace)", fontSize: 11.5, lineHeight: 1.45, maxHeight: 360, overflowY: "auto", whiteSpace: "pre-wrap" };
const runLogBox: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8, maxHeight: "min(58vh, 560px)", overflowY: "auto", paddingRight: 4 };
const toolRowHead: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "transparent", border: "none", padding: "8px 10px", color: t.text, cursor: "pointer" };
const runPre: React.CSSProperties = { background: t.inset, border: `1px solid ${t.border}`, borderRadius: 6, padding: 8, margin: 0, fontFamily: "var(--font-mono, monospace)", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word", overflowX: "auto" };

