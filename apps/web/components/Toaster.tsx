"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** The quiet confirmation (soul: voice.patterns.success — the artifact IS the
 *  message). One plate slides in low-right, states what happened, names the
 *  artifact in mono, leaves on its own. Errors stay longer and name what
 *  cracked. Renders on the .forge-toast* vocabulary (forge.css). */

type Tone = "info" | "ok" | "err";
type Toast = { id: number; body: string; meta?: string; tone: Tone };

const ToastContext = createContext<(body: string, opts?: { meta?: string; tone?: Tone }) => void>(
  () => {},
);

export function useToast() {
  return useContext(ToastContext);
}

export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const toast = useCallback((body: string, opts?: { meta?: string; tone?: Tone }) => {
    const id = nextId.current++;
    const tone = opts?.tone ?? "info";
    setToasts((t) => [...t, { id, body, meta: opts?.meta, tone }]);
    // errors linger — the smith reads what cracked; confirmations pass quickly
    const ttl = tone === "err" ? 8000 : 4500;
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {toasts.length > 0 && (
        <div className="forge-toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`forge-toast${t.tone === "ok" ? " is-ok" : t.tone === "err" ? " is-err" : ""}`}
              onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
            >
              <div className="forge-toast-body">
                {t.body}
                {t.meta && <div className="forge-toast-meta">{t.meta}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
