"use client";

/**
 * Forge lintel (verga) — Brokk product chrome.
 * Hauldr-like topbar form: brand + rooms + Anvil context + utils.
 * Soul stays Forge at Night — chrome quiet; ember only in work.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  LayoutGrid,
  MessageSquare,
  Plus,
  List,
  Users,
  Settings,
  Columns3,
  Anvil,
  Ellipsis,
  Gauge,
  Search,
  Link2,
  ChevronDown,
} from "lucide-react";
import { useProject } from "../lib/project-context";
import { ComposerMenu } from "./ComposerMenu";
import { CommandPalette } from "./CommandPalette";

type TopbarUserProps = { name: string; role?: string; authDisabled: boolean };

const PRIMARY = [
  { href: "/fleet", label: "Projects", icon: LayoutGrid, match: (p: string) => p === "/fleet" },
  { href: "/chat", label: "Chat", icon: MessageSquare, match: (p: string) => p.startsWith("/chat") },
] as const;

const BENCH = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge },
  { href: "/connect", label: "Connect", icon: Link2 },
  { href: "/history", label: "History", icon: List },
  { href: "/users", label: "Crew", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

function AnvilMenu() {
  const { projects, currentId, setCurrentId } = useProject();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const current = projects.find((p) => p.id === currentId);
  const label = current?.name ?? (projects.length ? "Pick project" : "No project");

  function pick(id: string) {
    setCurrentId(id);
    setOpen(false);
    if (path.startsWith("/projects/")) router.push(`/projects/${id}`);
  }

  return (
    <div className={`forge-slot${open ? " is-open" : ""}`}>
      <button
        type="button"
        className={`forge-anvil${open ? " is-open" : ""}`}
        aria-label={`Project on the anvil: ${label}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={projects.length === 0}
        title={label}
        onClick={() => {
          if (!projects.length) return;
          setActive(Math.max(0, projects.findIndex((p) => p.id === currentId)));
          setOpen((v) => !v);
        }}
      >
        <Anvil size={15} strokeWidth={1.75} aria-hidden />
        <span className="forge-anvil-name">{label}</span>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
      </button>
      <ComposerMenu
        open={open}
        placement="below"
        items={projects.map((p) => ({
          id: p.id,
          label: p.name,
          hint: p.id === currentId ? "on the anvil" : undefined,
          tag: p.id === currentId ? "live" : undefined,
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

function BenchMenu({ onSearch }: { onSearch: () => void }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const items = [
    { id: "cmdk", label: "Search…", hint: "⌘K", tag: "goto" },
    ...BENCH.map((n) => ({
      id: n.href,
      label: n.label,
      hint: undefined as string | undefined,
      tag: path.startsWith(n.href) ? "here" : undefined,
    })),
  ];
  const onBench = BENCH.some((n) => path.startsWith(n.href));

  return (
    <div className={`forge-slot forge-slot-end${open ? " is-open" : ""}`}>
      <button
        type="button"
        className={`forge-icon${onBench ? " is-on" : ""}`}
        aria-label="Bench"
        aria-expanded={open}
        title="Bench"
        onClick={() => {
          setActive(0);
          setOpen((v) => !v);
        }}
      >
        <Ellipsis size={16} strokeWidth={1.75} />
      </button>
      <ComposerMenu
        open={open}
        placement="below"
        items={items}
        activeIndex={active}
        onActiveIndex={setActive}
        onPick={(id) => {
          setOpen(false);
          if (id === "cmdk") onSearch();
          else router.push(id);
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

function UserMenu({ user }: { user: TopbarUserProps }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  return (
    <div className={`forge-slot forge-slot-end${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="forge-avatar"
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
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const boardHref = currentId ? `/projects/${currentId}` : "/fleet";
  const boardOn = path.startsWith("/projects") && !path.endsWith("/descoberta");
  const newOn = path === "/new" || path.startsWith("/new/");

  return (
    <header className="forge-bar" aria-label="Brokk forge bar">
      <Link href="/fleet" className="forge-brand" aria-label="Brokk">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brokk.svg" alt="" width={22} height={30} className="forge-brand-mark" />
        <span className="forge-brand-word">Brokk</span>
      </Link>

      <nav className="forge-rooms" aria-label="Primary">
        {PRIMARY.map((n) => {
          const Icon = n.icon;
          const on = n.match(path);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`forge-room-link${on ? " is-on" : ""}`}
              aria-current={on ? "page" : undefined}
            >
              <Icon size={15} strokeWidth={1.75} aria-hidden />
              <span>{n.label}</span>
            </Link>
          );
        })}
        <Link
          href={boardHref}
          className={`forge-room-link${boardOn ? " is-on" : ""}`}
          aria-current={boardOn ? "page" : undefined}
        >
          <Columns3 size={15} strokeWidth={1.75} aria-hidden />
          <span>Board</span>
        </Link>

        <Link
          href="/new"
          className={`forge-new${newOn ? " is-on" : ""}`}
          aria-current={newOn ? "page" : undefined}
          title="New project"
        >
          <Plus size={15} strokeWidth={2} aria-hidden />
          <span>New</span>
        </Link>
      </nav>

      <div className="forge-bar-spacer" aria-hidden />

      <AnvilMenu />

      <div className="forge-utils">
        <button
          type="button"
          className="forge-icon"
          onClick={openPalette}
          title="Search ⌘K"
          aria-label="Search"
        >
          <Search size={16} strokeWidth={1.75} />
        </button>
        <BenchMenu onSearch={openPalette} />
        {user ? <UserMenu user={user} /> : null}
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </header>
  );
}
