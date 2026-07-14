"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  NavSidebar,
  SidebarBrand,
  Nav,
  NavGroup,
  NavLink,
  SidebarFoot,
} from "@cold-code-labs/yggdrasil-react";
import {
  LayoutGrid,
  Gauge,
  MessageSquare,
  Plus,
  List,
  Users,
  Settings,
  Columns3,
  Feather,
  LogOut,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Anvil,
} from "lucide-react";
import { useProject } from "../lib/project-context";
import { ComposerMenu } from "./ComposerMenu";

const RAIL_KEY = "brokk.sidebar.collapsed";

// Global / project-agnostic — always see everything.
// ADR 0039: nav labels are functional, not codenames. "Projects" (was Fleet),
// "Chat" (was Sindri). The codenames live on in the packages/logs, not here.
// Mímir and Discovery left the nav (B3/B4): they're Brokk Skills now, invoked
// from Chat via `invoke_skill`. Their pages stay routable as break-glass.
const GLOBAL = [
  { href: "/fleet", label: "Projects", icon: <LayoutGrid /> },
  { href: "/dashboard", label: "Dashboard", icon: <Gauge /> },
] as const;

const ENV = [{ href: "/chat", label: "Chat", icon: <MessageSquare /> }] as const;

const MANAGE = [
  { href: "/new", label: "New Project", icon: <Feather /> },
  { href: "/connect", label: "Connect", icon: <Plus /> },
  { href: "/history", label: "History", icon: <List /> },
  { href: "/users", label: "Crew", icon: <Users /> },
  { href: "/settings", label: "Settings", icon: <Settings /> },
] as const;

type SidebarUserProps = { name: string; role?: string; authDisabled: boolean };

/** "Vitor Alves" → "VA" — the stamp on the identity plate. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

function roleLabel(role: string | undefined): string {
  if (!role) return "";
  const map: Record<string, string> = {
    proprietário: "Owner",
    proprietario: "Owner",
    owner: "Owner",
    admin: "Admin",
    member: "Member",
  };
  return map[role.trim().toLowerCase()] ?? role;
}

/** Forged anvil switcher — popover, never a native <select>. */
function ProjectSwitcher({ collapsed }: { collapsed: boolean }) {
  const { projects, currentId, setCurrentId } = useProject();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const current = projects.find((p) => p.id === currentId);
  const label = current?.name ?? (projects.length ? "Pick project" : "No projects");

  function pick(id: string) {
    setCurrentId(id);
    setOpen(false);
    if (path.startsWith("/projects/")) router.push(`/projects/${id}`);
  }

  return (
    <div className={`brokk-switch${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="brokk-switch-btn"
        aria-label="Project"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={projects.length === 0}
        title={collapsed ? label : undefined}
        data-tip={collapsed ? label : undefined}
        onClick={() => {
          if (projects.length === 0) return;
          setActive(Math.max(0, projects.findIndex((p) => p.id === currentId)));
          setOpen((v) => !v);
        }}
      >
        <Anvil size={14} aria-hidden className="brokk-switch-mark" />
        <span className="brokk-switch-label">{label}</span>
        <ChevronDown size={14} aria-hidden className="brokk-switch-caret" />
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

export default function Sidebar({ user }: { user?: SidebarUserProps }) {
  const path = usePathname();
  const { currentId } = useProject();
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(RAIL_KEY) === "1");
    } catch {
      /* ignore */
    }
    setReady(true);
  }, []);

  function toggleRail() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(RAIL_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const isActive = (href: string) =>
    href === "/fleet" ? path === "/fleet" : path.startsWith(href);

  return (
    <NavSidebar
      className={`brokk-rail${collapsed ? " is-collapsed" : ""}${ready ? " is-ready" : ""}`}
      data-collapsed={collapsed ? "true" : undefined}
      aria-label="Brokk"
    >
      <div className="brokk-rail-head">
        <SidebarBrand
          className="brokk-brand"
          mark={
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/brokk.svg" alt="" width={44} height={60} />
          }
          name={collapsed ? undefined : "Brokk"}
        />
        <button
          type="button"
          className="brokk-rail-toggle"
          onClick={toggleRail}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse"}
          data-tip={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <Nav>
        <NavGroup label={collapsed ? undefined : "Forge"}>
          {GLOBAL.map((n) => (
            <NavLink
              key={n.href}
              as={Link}
              href={n.href}
              icon={n.icon}
              active={isActive(n.href)}
              title={n.label}
              data-tip={collapsed ? n.label : undefined}
            >
              {n.label}
            </NavLink>
          ))}
        </NavGroup>

        <NavGroup label={collapsed ? undefined : "Anvil"}>
          <ProjectSwitcher collapsed={collapsed} />
          <NavLink
            as={Link}
            href={currentId ? `/projects/${currentId}` : "/fleet"}
            icon={<Columns3 />}
            active={path.startsWith("/projects") && !path.endsWith("/descoberta")}
            title="Board"
            data-tip={collapsed ? "Board" : undefined}
          >
            Board
          </NavLink>
          {ENV.map((n) => (
            <NavLink
              key={n.href}
              as={Link}
              href={n.href}
              icon={n.icon}
              active={isActive(n.href)}
              title={n.label}
              data-tip={collapsed ? n.label : undefined}
            >
              {n.label}
            </NavLink>
          ))}
        </NavGroup>
        <NavGroup label={collapsed ? undefined : "Bench"}>
          {MANAGE.map((n) => (
            <NavLink
              key={n.href}
              as={Link}
              href={n.href}
              icon={n.icon}
              active={isActive(n.href)}
              title={n.label}
              data-tip={collapsed ? n.label : undefined}
            >
              {n.label}
            </NavLink>
          ))}
        </NavGroup>
      </Nav>

      {user ? (
        <div className="brokk-user" title={user.name} data-tip={collapsed ? user.name : undefined}>
          <span className="brokk-user-plate" aria-hidden>
            {initials(user.name)}
          </span>
          <span className="brokk-user-id">
            <span className="brokk-user-name">{user.name}</span>
            <span className="brokk-user-role">
              {user.authDisabled ? "auth off" : roleLabel(user.role)}
            </span>
          </span>
          <a href="/sign-out" className="brokk-user-out" aria-label="Sign out" title="Sign out">
            <LogOut />
          </a>
        </div>
      ) : null}

      <SidebarFoot>
        <a
          href="https://github.com/cold-code-labs/brokk"
          target="_blank"
          rel="noreferrer"
        >
          cold-code-labs/brokk ↗
        </a>
      </SidebarFoot>
    </NavSidebar>
  );
}
