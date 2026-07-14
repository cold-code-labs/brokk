"use client";

/**
 * Wall Rail — Brokk chrome (litr-frontend-design remolho).
 * Form borrowed from v0/Lovable workbench (icon strip + overflow), soul stays
 * Forge at Night. Forever a 3.5rem strip — no fat SaaS sidebar with Forge/Anvil/Bench.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { NavSidebar } from "@cold-code-labs/yggdrasil-react";
import {
  LayoutGrid,
  MessageSquare,
  Plus,
  List,
  Users,
  Settings,
  Columns3,
  Feather,
  Anvil,
  Ellipsis,
  Gauge,
  Search,
} from "lucide-react";
import { useProject } from "../lib/project-context";
import { ComposerMenu } from "./ComposerMenu";
import { CommandPalette } from "./CommandPalette";

type SidebarUserProps = { name: string; role?: string; authDisabled: boolean };

const PRIMARY = [
  { href: "/fleet", label: "Projects", icon: LayoutGrid, match: (p: string) => p === "/fleet" },
  { href: "/chat", label: "Chat", icon: MessageSquare, match: (p: string) => p.startsWith("/chat") },
] as const;

const BENCH = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge },
  { href: "/new", label: "New project", icon: Feather },
  { href: "/connect", label: "Connect", icon: Plus },
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
  const tip = current?.name ?? (projects.length ? "Pick project" : "No projects");

  function pick(id: string) {
    setCurrentId(id);
    setOpen(false);
    if (path.startsWith("/projects/")) router.push(`/projects/${id}`);
  }

  return (
    <div className={`wall-slot wall-anvil${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="wall-btn"
        aria-label={`Project: ${tip}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={projects.length === 0}
        data-tip={tip}
        title={tip}
        onClick={() => {
          if (!projects.length) return;
          setActive(Math.max(0, projects.findIndex((p) => p.id === currentId)));
          setOpen((v) => !v);
        }}
      >
        <Anvil size={18} strokeWidth={1.75} />
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

  return (
    <div className={`wall-slot wall-bench${open ? " is-open" : ""}`}>
      <button
        type="button"
        className={`wall-btn${BENCH.some((n) => path.startsWith(n.href)) ? " is-on" : ""}`}
        aria-label="Bench"
        aria-expanded={open}
        data-tip="Bench"
        title="Bench"
        onClick={() => {
          setActive(0);
          setOpen((v) => !v);
        }}
      >
        <Ellipsis size={18} strokeWidth={1.75} />
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

function UserMenu({ user }: { user: SidebarUserProps }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  return (
    <div className={`wall-slot wall-user${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="wall-user-btn"
        aria-label={user.name}
        aria-expanded={open}
        data-tip={user.name}
        title={user.name}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="wall-user-plate" aria-hidden>
          {initials(user.name)}
        </span>
      </button>
      <ComposerMenu
        open={open}
        placement="above"
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

export default function Sidebar({ user }: { user?: SidebarUserProps }) {
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

  return (
    <NavSidebar className="wall-rail" aria-label="Brokk wall rail">
      <Link href="/fleet" className="wall-mark" aria-label="Brokk" data-tip="Brokk" title="Brokk">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brokk.svg" alt="" width={28} height={38} />
      </Link>

      <nav className="wall-nav" aria-label="Primary">
        {PRIMARY.map((n) => {
          const Icon = n.icon;
          const on = n.match(path);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`wall-btn${on ? " is-on" : ""}`}
              aria-current={on ? "page" : undefined}
              data-tip={n.label}
              title={n.label}
            >
              <Icon size={18} strokeWidth={1.75} />
            </Link>
          );
        })}

        <Link
          href={boardHref}
          className={`wall-btn${boardOn ? " is-on" : ""}`}
          aria-current={boardOn ? "page" : undefined}
          data-tip="Board"
          title="Board"
        >
          <Columns3 size={18} strokeWidth={1.75} />
        </Link>

        <AnvilMenu />

        <span className="wall-rule" aria-hidden />

        <button
          type="button"
          className="wall-btn"
          onClick={openPalette}
          data-tip="Search ⌘K"
          title="Search ⌘K"
          aria-label="Search"
        >
          <Search size={18} strokeWidth={1.75} />
        </button>

        <BenchMenu onSearch={openPalette} />
      </nav>

      <div className="wall-foot">{user ? <UserMenu user={user} /> : null}</div>

      {/* Fixed scrim: keep inside the rail so AppShell grid stays 2 columns. */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </NavSidebar>
  );
}
