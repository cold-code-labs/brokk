"use client";

import { useEffect, useRef } from "react";

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
};

/** Forge-flavoured popover for cockpit chips and `/` skill slash. */
export function ComposerMenu({
  open,
  items,
  activeIndex,
  onActiveIndex,
  onPick,
  onClose,
  placement = "above",
  emptyHint = "Nothing matches",
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = rootRef.current?.querySelector(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      className={`sindri-menu sindri-menu--${placement}`}
      role="listbox"
      aria-label="Options"
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
            aria-selected={i === activeIndex}
            data-idx={i}
            className={`sindri-menu-item${i === activeIndex ? " is-active" : ""}`}
            onMouseEnter={() => onActiveIndex(i)}
            onClick={() => onPick(item.id)}
          >
            <span className="sindri-menu-item-mark" aria-hidden="true" />
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
}
