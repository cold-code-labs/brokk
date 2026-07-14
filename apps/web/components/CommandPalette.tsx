"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutGrid,
  MessageSquare,
  Columns3,
  Gauge,
  Feather,
  Plus,
  List,
  Users,
  Settings,
} from "lucide-react";
import { useProject } from "../lib/project-context";

type Item = {
  id: string;
  label: string;
  hint?: string;
  href: string;
  icon: ReactNode;
  group: string;
};

/**
 * ⌘K workbench palette — jump to rooms / projects without the fat sidebar.
 */
export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const path = usePathname();
  const { projects, setCurrentId, currentId } = useProject();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  const items = useMemo<Item[]>(() => {
    const rooms: Item[] = [
      { id: "fleet", label: "Projects", hint: "Fleet floor", href: "/fleet", icon: <LayoutGrid size={15} />, group: "Rooms" },
      { id: "chat", label: "Chat", hint: "Sindri cockpit", href: "/chat", icon: <MessageSquare size={15} />, group: "Rooms" },
      {
        id: "board",
        label: "Board",
        hint: "Anvil",
        href: currentId ? `/projects/${currentId}` : "/fleet",
        icon: <Columns3 size={15} />,
        group: "Rooms",
      },
      { id: "dash", label: "Dashboard", href: "/dashboard", icon: <Gauge size={15} />, group: "Rooms" },
      { id: "new", label: "New project", href: "/new", icon: <Feather size={15} />, group: "Bench" },
      { id: "connect", label: "Connect", href: "/connect", icon: <Plus size={15} />, group: "Bench" },
      { id: "history", label: "History", href: "/history", icon: <List size={15} />, group: "Bench" },
      { id: "crew", label: "Crew", href: "/users", icon: <Users size={15} />, group: "Bench" },
      { id: "settings", label: "Settings", href: "/settings", icon: <Settings size={15} />, group: "Bench" },
    ];
    const proj: Item[] = projects.map((p) => ({
      id: `p-${p.id}`,
      label: p.name,
      hint: "Set anvil · open board",
      href: `/projects/${p.id}`,
      icon: <Columns3 size={15} />,
      group: "Projects",
    }));
    const all = [...rooms, ...proj];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (i) =>
        i.label.toLowerCase().includes(needle) ||
        (i.hint && i.hint.toLowerCase().includes(needle)),
    );
  }, [projects, currentId, q]);

  useEffect(() => {
    if (!open) {
      setQ("");
      setActive(0);
      return;
    }
    setActive(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, Math.max(0, items.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hit = items[active];
        if (hit) go(hit);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, items, active, onClose]);

  function go(item: Item) {
    if (item.id.startsWith("p-")) {
      const id = item.id.slice(2);
      setCurrentId(id);
    }
    if (item.href !== path) router.push(item.href);
    onClose();
  }

  if (!open) return null;

  let lastGroup = "";

  return (
    <div className="cmdk-scrim" role="presentation" onClick={onClose}>
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cmdk-bar">
          <input
            className="cmdk-input"
            // biome-ignore lint/a11y/noAutofocus: palette opened by intentional shortcut
            autoFocus
            placeholder="Jump to a room or project…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
          />
          <kbd className="cmdk-kbd">esc</kbd>
        </div>
        <div className="cmdk-list" role="listbox">
          {items.length === 0 ? (
            <div className="cmdk-empty">Nothing matches</div>
          ) : (
            items.map((item, i) => {
              const showGroup = item.group !== lastGroup;
              lastGroup = item.group;
              return (
                <div key={item.id}>
                  {showGroup ? <div className="cmdk-group">{item.group}</div> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    className={`cmdk-item${i === active ? " is-active" : ""}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(item)}
                  >
                    <span className="cmdk-item-ico" aria-hidden>
                      {item.icon}
                    </span>
                    <span className="cmdk-item-body">
                      <span className="cmdk-item-label">{item.label}</span>
                      {item.hint ? <span className="cmdk-item-hint">{item.hint}</span> : null}
                    </span>
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
