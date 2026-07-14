"use client";

import { useCallback, useEffect, useState } from "react";
import { GitCommitHorizontal, Loader2 } from "lucide-react";
import { chat } from "../lib/chat";
import { useToast } from "./Toaster";

const spin = { animation: "sindri-spin 0.7s linear infinite" } as const;

/**
 * Lands dirty preview/dev worktree edits onto origin/dev.
 * Visible only when the tree has tracked changes — pair with the agent
 * COMMIT POLICY (no auto-push). Publicar stays the ADR 0038 prod gesture.
 */
export default function CommitControls({
  projectId,
  sessionId,
  /** Bumps when edits land — re-check dirty sooner than the poll. */
  nudge = 0,
}: {
  projectId: string;
  sessionId?: string | null;
  nudge?: number;
}) {
  const toast = useToast();
  const [dirty, setDirty] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const st = await chat.devtreeStatus(projectId, sessionId);
      if (st.missing) {
        setDirty(false);
        setFiles([]);
        return;
      }
      setDirty(!!st.dirty);
      setFiles(st.files ?? []);
    } catch {
      /* best-effort chip */
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 8_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!nudge) return;
    const t = setTimeout(() => void refresh(), 1_200);
    return () => clearTimeout(t);
  }, [nudge, refresh]);

  // Re-check shortly after a turn likely finished writing files.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  if (!dirty) return null;

  async function commit() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await chat.devtreeCommit(projectId, { sessionId });
      toast(`Committed ${r.sha.slice(0, 7)} → ${r.branch}`, { tone: "ok" });
      setDirty(false);
      setFiles([]);
      void refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: "err" });
    } finally {
      setBusy(false);
    }
  }

  const title =
    files.length > 0
      ? `Uncommitted on dev:\n${files.slice(0, 12).join("\n")}${files.length > 12 ? "\n…" : ""}`
      : "Uncommitted changes on the preview worktree";

  return (
    <button
      type="button"
      className="sindri-commit"
      onClick={commit}
      disabled={busy}
      title={title}
    >
      {busy ? <Loader2 size={14} style={spin} /> : <GitCommitHorizontal size={14} />}
      Commit{files.length ? ` · ${files.length}` : ""}
    </button>
  );
}
