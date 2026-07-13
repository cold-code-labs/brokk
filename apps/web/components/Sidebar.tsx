"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
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
} from "lucide-react";
import { useProject } from "../lib/project-context";

// Global / project-agnostic — always see everything.
// ADR 0039: nav labels are functional, not codenames. "Projects" (was Fleet),
// "Chat" (was Sindri). The codenames live on in the packages/logs, not here.
// Mímir and Discovery left the nav (B3/B4): they're Brokk Skills now, invoked
// from Chat via `invoke_skill`. Their pages stay routable as break-glass.
const GLOBAL = [
  { href: "/fleet", label: "Projects", icon: <LayoutGrid /> },
  { href: "/dashboard", label: "Dashboard", icon: <Gauge /> },
] as const;

// Project-scoped — these operate on the selected project (the anvil). (Board's
// href is dynamic, so it's rendered separately.)
const ENV = [
  { href: "/chat", label: "Chat", icon: <MessageSquare /> },
] as const;

/** Environment switcher — the current project drives every project-scoped page.
 *  Switching while on a board re-routes to that project's board. */
function ProjectSwitcher() {
  const { projects, currentId, setCurrentId } = useProject();
  const path = usePathname();
  const router = useRouter();

  function pick(id: string) {
    setCurrentId(id);
    if (path.startsWith("/projects/")) router.push(`/projects/${id}`);
  }

  return (
    <div className="brokk-switch">
      <select
        value={currentId}
        onChange={(e) => pick(e.target.value)}
        disabled={projects.length === 0}
        aria-label="Project"
      >
        {projects.length === 0 && <option value="">no projects yet</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

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

// Role shown in the identity pod — kept short and in the app's language (English),
// so the pod reads as one quiet line (crit #6: "PROPRIETÁRIO" was a shout).
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

export default function Sidebar({ user }: { user?: SidebarUserProps }) {
  const path = usePathname();
  const { currentId } = useProject();
  const isActive = (href: string) =>
    href === "/fleet" ? path === "/fleet" : path.startsWith(href);

  return (
    <NavSidebar>
      <SidebarBrand
        className="brokk-brand"
        mark={
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/brokk.svg" alt="" width={44} height={60} />
        }
        name="Brokk"
      />

      <Nav>
        {/* Global — agnostic to the selected project; always sees everything. */}
        <NavGroup label="Forge">
          {GLOBAL.map((n) => (
            <NavLink
              key={n.href}
              as={Link}
              href={n.href}
              icon={n.icon}
              active={isActive(n.href)}
            >
              {n.label}
            </NavLink>
          ))}
        </NavGroup>

        {/* Project-scoped — the switcher + the pages that operate on it. */}
        <NavGroup label="Anvil">
          <ProjectSwitcher />
          <NavLink
            as={Link}
            href={currentId ? `/projects/${currentId}` : "/fleet"}
            icon={<Columns3 />}
            active={path.startsWith("/projects") && !path.endsWith("/descoberta")}
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
            >
              {n.label}
            </NavLink>
          ))}
        </NavGroup>
        <NavGroup label="Bench">
          {MANAGE.map((n) => (
            <NavLink
              key={n.href}
              as={Link}
              href={n.href}
              icon={n.icon}
              active={isActive(n.href)}
            >
              {n.label}
            </NavLink>
          ))}
        </NavGroup>
      </Nav>

      {user ? (
        <div className="brokk-user">
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
