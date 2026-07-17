"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

export type ComposerMenuItem = {
  id: string;
  label: string;
  hint?: string;
  /** Small eyebrow / kind tag */
  tag?: string;
};

type Props = {
  open: boolean;
  items: ComposerMenuItem[];
  activeIndex: number;
  onActiveIndex: (i: number) => void;
  onPick: (id: string) => void;
  onClose: () => void;
  /** Above the composer by default */
  placement?: "above" | "below";
  emptyHint?: string;
  /**
   * Escape overflow (forge-bar / sticky shells): portal to body + fixed coords
   * from the anchor. Required when a parent uses overflow:hidden.
   */
  portal?: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
  /** Align the fixed menu to the anchor's right edge (Bench / User). */
  align?: "start" | "end";
  /** The item currently in force — gets a check instead of the bullet. */
  selectedId?: string;
};

/** Forge-flavoured popover for cockpit chips, slash skills, and forge-bar pops. */
export function ComposerMenu({
  open,
  items,
  activeIndex,
  onActiveIndex,
  onPick,
  onClose,
  placement = "above",
  emptyHint = "Nothing matches",
  portal = false,
  anchorRef,
  align = "start",
  selectedId,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [fixedStyle, setFixedStyle] = useState<CSSProperties | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    if (!open || !portal || !anchorRef?.current) {
      setFixedStyle(null);
      return;
    }
    function place() {
      const el = anchorRef?.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const gap = 6;
      const minW = Math.max(r.width, 14 * 16);
      // Always set left/right explicitly — base `.sindri-menu { left: 0 }` must not win.
      const style: CSSProperties = {
        position: "fixed",
        zIndex: 200,
        minWidth: minW,
        maxWidth: "min(22rem, calc(100vw - 1.5rem))",
        maxHeight: "min(16rem, calc(100vh - 4rem))",
        top: placement === "below" ? r.bottom + gap : "auto",
        bottom: placement === "above" ? window.innerHeight - r.top + gap : "auto",
        left: align === "start" ? Math.max(gap, Math.min(r.left, window.innerWidth - gap - minW)) : "auto",
        right: align === "end" ? Math.max(gap, window.innerWidth - r.right) : "auto",
      };
      setFixedStyle(style);
    }
    place();
    window.addEventListener("resize", place);
    // capture scroll from any pane (Sindri thread, etc.)
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, portal, anchorRef, placement, align]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (anchorRef?.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = rootRef.current?.querySelector(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  if (!open) return null;
  if (portal && !mounted) return null;
  if (portal && !fixedStyle) return null;

  const node = (
    <div
      ref={rootRef}
      className={`sindri-menu${portal ? " is-portaled" : ` sindri-menu--${placement}`}`}
      role="listbox"
      aria-label="Options"
      style={portal ? fixedStyle ?? undefined : undefined}
    >
      <div className="sindri-menu-glow" aria-hidden="true" />
      {items.length === 0 ? (
        <div className="sindri-menu-empty">{emptyHint}</div>
      ) : (
        items.map((item, i) => (
          <button
            key={item.id}
            type="button"
            role="option"
            data-idx={i}
            className={`sindri-menu-item${i === activeIndex ? " is-active" : ""}${
              selectedId && item.id === selectedId ? " is-selected" : ""
            }`}
            aria-selected={selectedId ? item.id === selectedId : i === activeIndex}
            onMouseEnter={() => onActiveIndex(i)}
            onClick={() => onPick(item.id)}
          >
            {selectedId ? (
              <span className="sindri-menu-item-check" aria-hidden="true">
                {item.id === selectedId ? <Check size={13} /> : null}
              </span>
            ) : (
              <span className="sindri-menu-item-mark" aria-hidden="true" />
            )}
            <span className="sindri-menu-item-body">
              <span className="sindri-menu-item-row">
                <span className="sindri-menu-item-label">{item.label}</span>
                {item.tag ? <span className="sindri-menu-item-tag">{item.tag}</span> : null}
              </span>
              {item.hint ? <span className="sindri-menu-item-hint">{item.hint}</span> : null}
            </span>
          </button>
        ))
      )}
    </div>
  );

  return portal ? createPortal(node, document.body) : node;
}
