"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Global "current project" — Brokk treats each project as an ENVIRONMENT. One
// selector (Anvil) drives every project-scoped page. House cockpit adds pins,
// last-session-per-project, and intake drafts (localStorage, CCL staff v1).
// ─────────────────────────────────────────────────────────────────────────────

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Project } from "@brokk/sdk";
import { brokk } from "./api";
import {
  HOUSE_DRAFTS_KEY,
  HOUSE_PINS_KEY,
  HOUSE_SESSIONS_KEY,
  readJson,
  writeJson,
} from "./house";

const KEY = "brokk.currentProjectId";
const MAX_PINS = 9;

interface ProjectCtx {
  projects: Project[];
  currentId: string;
  current: Project | null;
  setCurrentId: (id: string) => void;
  loading: boolean;
  refresh: () => void;
  /** Pinned project ids for the House strip (order = keyboard 1–9). */
  pinnedIds: string[];
  togglePin: (id: string) => void;
  setPinnedIds: (ids: string[]) => void;
  pinnedProjects: Project[];
  lastSessionByProject: Record<string, string>;
  setLastSession: (projectId: string, sessionId: string | null) => void;
  getLastSession: (projectId: string) => string | null;
  draftsByProject: Record<string, string>;
  setDraft: (projectId: string, draft: string) => void;
  getDraft: (projectId: string) => string;
}

const Ctx = createContext<ProjectCtx | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  /**
   * Starts EMPTY on both server and client, and only picks up localStorage in an
   * effect. This used to read localStorage straight from the useState initializer
   * ("to avoid a flash") — which silently broke every control gated on the
   * project. The server has no localStorage, so it rendered `disabled` into the
   * HTML; the client's first render already had the id, so from React's side the
   * prop never *changed* and it never rewrote the attribute — and React does not
   * reconcile attributes during hydration, only text. The `disabled` from the
   * server stuck forever, with no warning: "New session" and the blank state's
   * "open an empty session" were dead on arrival. Setting it in an effect makes
   * the two first renders agree, so the update is real and lands in the DOM.
   */
  const [currentId, setId] = useState<string>("");
  const [pinnedIds, setPinnedIdsState] = useState<string[]>([]);
  const [lastSessionByProject, setLastSessionByProject] = useState<Record<string, string>>({});
  const [draftsByProject, setDraftsByProject] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored) setId(stored);
    } catch {
      /* ignore */
    }
    setPinnedIdsState(readJson<string[]>(HOUSE_PINS_KEY, []));
    setLastSessionByProject(readJson<Record<string, string>>(HOUSE_SESSIONS_KEY, {}));
    setDraftsByProject(readJson<Record<string, string>>(HOUSE_DRAFTS_KEY, {}));
  }, []);

  const setCurrentId = useCallback((id: string) => {
    setId(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  const setPinnedIds = useCallback((ids: string[]) => {
    const next = ids.slice(0, MAX_PINS);
    setPinnedIdsState(next);
    writeJson(HOUSE_PINS_KEY, next);
  }, []);

  const togglePin = useCallback(
    (id: string) => {
      setPinnedIdsState((prev) => {
        const next = prev.includes(id)
          ? prev.filter((x) => x !== id)
          : prev.length >= MAX_PINS
            ? prev
            : [...prev, id];
        writeJson(HOUSE_PINS_KEY, next);
        return next;
      });
    },
    [],
  );

  const setLastSession = useCallback((projectId: string, sessionId: string | null) => {
    setLastSessionByProject((prev) => {
      const next = { ...prev };
      if (!sessionId) delete next[projectId];
      else next[projectId] = sessionId;
      writeJson(HOUSE_SESSIONS_KEY, next);
      return next;
    });
  }, []);

  const getLastSession = useCallback(
    (projectId: string) => lastSessionByProject[projectId] ?? null,
    [lastSessionByProject],
  );

  const setDraft = useCallback((projectId: string, draft: string) => {
    setDraftsByProject((prev) => {
      const next = { ...prev };
      if (!draft.trim()) delete next[projectId];
      else next[projectId] = draft;
      writeJson(HOUSE_DRAFTS_KEY, next);
      return next;
    });
  }, []);

  const getDraft = useCallback(
    (projectId: string) => draftsByProject[projectId] ?? "",
    [draftsByProject],
  );

  function load() {
    brokk
      .listProjects()
      .then((p) => {
        setProjects(p);
        const valid = new Set(p.map((x) => x.id));
        // Drop pins / sessions that no longer exist.
        setPinnedIdsState((prev) => {
          const next = prev.filter((id) => valid.has(id));
          if (next.length !== prev.length) writeJson(HOUSE_PINS_KEY, next);
          return next;
        });
        setLastSessionByProject((prev) => {
          const next: Record<string, string> = {};
          for (const [k, v] of Object.entries(prev)) {
            if (valid.has(k)) next[k] = v;
          }
          if (Object.keys(next).length !== Object.keys(prev).length) {
            writeJson(HOUSE_SESSIONS_KEY, next);
          }
          return next;
        });
        // Keep the current pick if still valid; else fall back to stored, else first.
        setId((cur) => {
          if (cur && p.some((x) => x.id === cur)) return cur;
          // Never strand a valid pick behind a transient/empty list (e.g. a just-
          // connected project the backend hasn't surfaced yet): keep the current
          // choice and let the next successful load reconcile it, instead of
          // wiping the selection to "" and dropping the user out of their env.
          if (p.length === 0) return cur;
          let stored = "";
          try {
            stored = localStorage.getItem(KEY) ?? "";
          } catch {
            /* ignore */
          }
          return (stored && p.some((x) => x.id === stored) ? stored : p[0]?.id) ?? "";
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // Revalidate when the operator returns to the tab so a project connected in
    // another view (or reaped/renamed) shows up without a hard reload.
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const current = useMemo(
    () => projects.find((p) => p.id === currentId) ?? null,
    [projects, currentId],
  );

  const pinnedProjects = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    return pinnedIds.map((id) => byId.get(id)).filter((p): p is Project => !!p);
  }, [projects, pinnedIds]);

  const value = useMemo<ProjectCtx>(
    () => ({
      projects,
      currentId,
      current,
      setCurrentId,
      loading,
      refresh: load,
      pinnedIds,
      togglePin,
      setPinnedIds,
      pinnedProjects,
      lastSessionByProject,
      setLastSession,
      getLastSession,
      draftsByProject,
      setDraft,
      getDraft,
    }),
    [
      projects,
      currentId,
      current,
      setCurrentId,
      loading,
      pinnedIds,
      togglePin,
      setPinnedIds,
      pinnedProjects,
      lastSessionByProject,
      setLastSession,
      getLastSession,
      draftsByProject,
      setDraft,
      getDraft,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProject(): ProjectCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProject must be used within ProjectProvider");
  return v;
}
