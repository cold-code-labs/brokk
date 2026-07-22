"use client";

/**
 * Forge lintel — brand · rooms · bench links · Anvil · user (extrema direita).
 * Sem ⌘K / Bench overflow. Menus Anvil/User portalizam sob o âncora.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState } from "react";
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
  { href: "/fleet", label: "Projects", icon: LayoutGrid, match: (p: string) => p === "/fleet" },
  { href: "/chat", label: "Chat", icon: MessageSquare, match: (p: string) => p.startsWith("/chat") },
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
  const { projects, currentId, setCurrentId } = useProject();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
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
        ref={btnRef}
        type="button"
        className={`forge-ctrl forge-anvil${open ? " is-open" : ""}`}
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
