"use client";

/**
 * Forge lintel — brand · rooms · bench links · Anvil · user (extrema direita).
 * Sem ⌘K / Bench overflow. Menus Anvil/User portalizam sob o âncora.
 * House pins: keys 1–9 jump to that anvil's chat (when focus is not in an input).
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutGrid,
  MessageSquare,
  Plus,
  List,
  Users,
  Settings,
  Columns3,
  Anvil,
  Gauge,
  Link2,
  ChevronDown,
} from "lucide-react";
import { useProject } from "../lib/project-context";
import { ComposerMenu } from "./ComposerMenu";

type TopbarUserProps = { name: string; role?: string; authDisabled: boolean };

const ROOMS = [
  { href: "/fleet", label: "House", icon: LayoutGrid, match: (p: string) => p === "/fleet" },
  { href: "/chat", label: "Chat", icon: MessageSquare, match: (p: string) => p.startsWith("/chat") },
  { href: "/mission", label: "Mission", icon: Columns3, match: (p: string) => p.startsWith("/mission") },
] as const;

const BENCH = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge, match: (p: string) => p.startsWith("/dashboard") },
  { href: "/connect", label: "Connect", icon: Link2, match: (p: string) => p.startsWith("/connect") },
  { href: "/history", label: "History", icon: List, match: (p: string) => p.startsWith("/history") },
  { href: "/users", label: "Crew", icon: Users, match: (p: string) => p.startsWith("/users") },
  { href: "/settings", label: "Settings", icon: Settings, match: (p: string) => p.startsWith("/settings") },
] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

function AnvilMenu() {
  const { projects, currentId, setCurrentId, pinnedIds, getLastSession } = useProject();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = projects.find((p) => p.id === currentId);
  const label = current?.name ?? (projects.length ? "Pick project" : "No project");

  /** Pins first (House order), then the rest alphabetically. */
  const ordered = useMemo(() => {
    const pinSet = new Set(pinnedIds);
    const pinned = pinnedIds
      .map((id) => projects.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => !!p);
    const rest = projects
      .filter((p) => !pinSet.has(p.id))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...pinned, ...rest];
  }, [projects, pinnedIds]);

  function pick(id: string) {
    setCurrentId(id);
    setOpen(false);
    if (path.startsWith("/projects/")) router.push(`/projects/${id}`);
    else if (path.startsWith("/chat")) {
      const sid = getLastSession(id);
      router.push(sid ? `/chat?session=${encodeURIComponent(sid)}` : "/chat");
    }
  }

  return (
    <div className={`forge-slot${open ? " is-open" : ""}`}>
      <button
        ref={btnRef}
        type="button"
        className={`forge-ctrl forge-anvil${open ? " is-open" : ""}`}
        aria-label={`Project on the anvil: ${label}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={projects.length === 0}
        title={label}
        onClick={() => {
          if (!ordered.length) return;
          setActive(Math.max(0, ordered.findIndex((p) => p.id === currentId)));
          setOpen((v) => !v);
        }}
      >
        <Anvil size={15} strokeWidth={1.75} aria-hidden className="forge-ctrl-ico" />
        <span className="forge-anvil-name">{label}</span>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="forge-ctrl-caret" />
      </button>
      <ComposerMenu
        open={open}
        placement="below"
        portal
        anchorRef={btnRef}
        align="start"
        items={ordered.map((p) => ({
          id: p.id,
          label: p.name,
          hint: p.id === currentId
            ? "on the anvil"
            : pinnedIds.includes(p.id)
              ? "pinned"
              : undefined,
          tag: p.id === currentId ? "live" : pinnedIds.includes(p.id) ? "pin" : undefined,
        }))}
        activeIndex={active}
        onActiveIndex={setActive}
        onPick={pick}
        onClose={() => setOpen(false)}
        emptyHint="Connect a repo first"
      />
    </div>
  );
}

/** Digits 1–9 → open pinned anvil chat (skip when typing in a field). */
function useHousePinKeys() {
  const { pinnedProjects, setCurrentId, getLastSession } = useProject();
  const router = useRouter();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) {
          return;
        }
      }
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const proj = pinnedProjects[n - 1];
      if (!proj) return;
      e.preventDefault();
      setCurrentId(proj.id);
      const sid = getLastSession(proj.id);
      router.push(sid ? `/chat?session=${encodeURIComponent(sid)}` : "/chat");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinnedProjects, setCurrentId, getLastSession, router]);
}

function UserMenu({ user }: { user: TopbarUserProps }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <div className={`forge-slot forge-user-slot${open ? " is-open" : ""}`}>
      <button
        ref={btnRef}
        type="button"
        className={`forge-ctrl forge-avatar${open ? " is-open" : ""}`}
        aria-label={user.name}
        aria-expanded={open}
        title={user.name}
        onClick={() => setOpen((v) => !v)}
      >
        {initials(user.name)}
      </button>
      <ComposerMenu
        open={open}
        placement="below"
        portal
        anchorRef={btnRef}
        align="end"
        items={[
          {
            id: "who",
            label: user.name,
            hint: user.authDisabled ? "auth off" : user.role || "member",
          },
          { id: "out", label: "Sign out", tag: "leave" },
        ]}
        activeIndex={active}
        onActiveIndex={setActive}
        onPick={(id) => {
          setOpen(false);
          if (id === "out") window.location.href = "/sign-out";
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

export default function Topbar({ user }: { user?: TopbarUserProps }) {
  const path = usePathname();
  const { currentId } = useProject();
  useHousePinKeys();

  const boardHref = currentId ? `/projects/${currentId}` : "/fleet";
  const boardOn =
    path.startsWith("/projects") &&
    !path.endsWith("/descoberta") &&
    !/\/qa\/?$/.test(path);
  const newOn = path === "/new" || path.startsWith("/new/");

  return (
    <header className="forge-lintel" aria-label="Brokk forge lintel">
      <div className="forge-lintel-inner">
        <Link href="/fleet" className="forge-brand" aria-label="Brokk">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brokk.svg" alt="" width={22} height={30} className="forge-brand-mark" />
          <span className="forge-brand-word">Brokk</span>
        </Link>

        <nav className="forge-rooms" aria-label="Primary">
          {ROOMS.map((n) => {
            const Icon = n.icon;
            const on = n.match(path);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`forge-ctrl forge-room-link${on ? " is-on" : ""}`}
                aria-current={on ? "page" : undefined}
              >
                <Icon size={15} strokeWidth={1.75} aria-hidden />
                <span>{n.label}</span>
              </Link>
            );
          })}
          <Link
            href={boardHref}
            className={`forge-ctrl forge-room-link${boardOn ? " is-on" : ""}`}
            aria-current={boardOn ? "page" : undefined}
          >
            <Columns3 size={15} strokeWidth={1.75} aria-hidden />
            <span>Forge</span>
          </Link>
          <Link
            href="/new"
            className={`forge-ctrl forge-new${newOn ? " is-on" : ""}`}
            aria-current={newOn ? "page" : undefined}
            title="New project"
          >
            <Plus size={15} strokeWidth={2} aria-hidden />
            <span>New</span>
          </Link>
        </nav>

        <nav className="forge-bench" aria-label="Workbench">
          {BENCH.map((n) => {
            const Icon = n.icon;
            const on = n.match(path);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`forge-ctrl forge-bench-link${on ? " is-on" : ""}`}
                aria-current={on ? "page" : undefined}
              >
                <Icon size={15} strokeWidth={1.75} aria-hidden />
                <span>{n.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="forge-lintel-spacer" aria-hidden />

        <AnvilMenu />
        {user ? <UserMenu user={user} /> : null}
      </div>
    </header>
  );
}
