"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useProject } from "./project-context";

export type StageMode = "house" | "preview" | "forge";

type CockpitContextValue = {
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  stageMode: StageMode;
  setStageMode: (mode: StageMode) => void;
  /** Select project and open the left chat rail (stay on House). */
  openProjectChat: (projectId: string) => void;
  closeChat: () => void;
  /** True after the operator explicitly picks a project this session. */
  hasPicked: boolean;
};

const CockpitContext = createContext<CockpitContextValue | null>(null);

export function CockpitProvider({ children }: { children: ReactNode }) {
  const { setCurrentId } = useProject();
  const [chatOpen, setChatOpen] = useState(false);
  const [stageMode, setStageMode] = useState<StageMode>("house");
  const [hasPicked, setHasPicked] = useState(false);

  const openProjectChat = useCallback(
    (projectId: string) => {
      setCurrentId(projectId);
      setHasPicked(true);
      setChatOpen(true);
    },
    [setCurrentId],
  );

  const closeChat = useCallback(() => setChatOpen(false), []);

  const setChatOpenSafe = useCallback((open: boolean) => {
    if (open && !hasPicked) return;
    setChatOpen(open);
  }, [hasPicked]);

  const value = useMemo(
    () => ({
      chatOpen,
      setChatOpen: setChatOpenSafe,
      stageMode,
      setStageMode,
      openProjectChat,
      closeChat,
      hasPicked,
    }),
    [chatOpen, setChatOpenSafe, stageMode, openProjectChat, closeChat, hasPicked],
  );

  return <CockpitContext.Provider value={value}>{children}</CockpitContext.Provider>;
}

export function useCockpit(): CockpitContextValue {
  const ctx = useContext(CockpitContext);
  if (!ctx) {
    throw new Error("useCockpit must be used inside CockpitProvider");
  }
  return ctx;
}

/** Optional hook — Topbar / FleetView may run outside the cockpit. */
export function useCockpitOptional(): CockpitContextValue | null {
  return useContext(CockpitContext);
}
