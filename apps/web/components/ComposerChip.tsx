"use client";

import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { ComposerMenu, type ComposerMenuItem } from "./ComposerMenu";

type Props = {
  title: string;
  value: string;
  items: ComposerMenuItem[];
  onChange: (id: string) => void;
  icon?: ReactNode;
  /** Extra class on the chip (e.g. sindri-effort) */
  className?: string;
  /** Custom trigger body instead of the selected label */
  trigger?: ReactNode;
};

/** Chip that opens a forge menu instead of a native <select>. */
export function ComposerChip({ title, value, items, onChange, icon, className, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const selected = items.find((i) => i.id === value);
  const label = selected?.label ?? value;

  const close = useCallback(() => setOpen(false), []);

  function openMenu() {
    const idx = Math.max(0, items.findIndex((i) => i.id === value));
    setActive(idx);
    setOpen(true);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % Math.max(items.length, 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + items.length) % Math.max(items.length, 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = items[active];
      if (item) {
        onChange(item.id);
        close();
      }
    }
  }

  return (
    <div className={`sindri-chip-wrap${open ? " is-open" : ""}`}>
      <button
        ref={anchorRef}
        type="button"
        className={`sindri-chip${className ? ` ${className}` : ""}`}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelId}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
      >
        {icon}
        <span id={labelId} className="sindri-chip-label">
          {trigger ?? label}
        </span>
      </button>
      {/* Portaled + right-aligned: these chips sit at the right edge of the
          cockpit, and an absolutely-positioned menu (min-width 22rem, left:0)
          ran off the column and gave the page a horizontal scroll. The portal
          also escapes `.sindri-chat { overflow: hidden }`. */}
      <ComposerMenu
        open={open}
        portal
        anchorRef={anchorRef}
        align="end"
        placement="above"
        items={items}
        selectedId={value}
        activeIndex={active}
        onActiveIndex={setActive}
        onPick={(id) => {
          onChange(id);
          close();
        }}
        onClose={close}
      />
    </div>
  );
}
