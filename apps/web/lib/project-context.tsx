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
  // Hydrate from localStorage immediately (client-only) to avoid a flash.
  const [currentId, setId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try {
      return localStorage.getItem(KEY) ?? "";
    } catch {
      return "";
    }
  });
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
