"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Global "current project" — Brokk treats each project as an ENVIRONMENT. One
// selector (in the sidebar) drives every project-scoped page (Quadro, Sindri…),
// so you pick the project once and the whole app follows. Persisted to
// localStorage so the choice survives reloads.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Project } from "@brokk/sdk";
import { brokk } from "./api";

const KEY = "brokk.currentProjectId";

interface ProjectCtx {
  projects: Project[];
  currentId: string;
  current: Project | null;
  setCurrentId: (id: string) => void;
  loading: boolean;
  refresh: () => void;
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
  useEffect(() => {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored) setId(stored);
    } catch {
      /* ignore */
    }
  }, []);
  const [loading, setLoading] = useState(true);

  const setCurrentId = (id: string) => {
    setId(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* ignore */
    }
  };

  function load() {
    brokk
      .listProjects()
      .then((p) => {
        setProjects(p);
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

  const current = useMemo(() => projects.find((p) => p.id === currentId) ?? null, [projects, currentId]);

  return (
    <Ctx.Provider value={{ projects, currentId, current, setCurrentId, loading, refresh: load }}>
      {children}
    </Ctx.Provider>
  );
}

export function useProject(): ProjectCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProject must be used within ProjectProvider");
  return v;
}
