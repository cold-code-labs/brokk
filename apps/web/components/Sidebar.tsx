"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  NavSidebar,
  SidebarBrand,
  Nav,
  NavGroup,
  NavLink,
  SidebarUser,
  SidebarFoot,
} from "@cold-code-labs/yggdrasil-react";
import {
  LayoutGrid,
  Gauge,
  Sparkles,
  BookText,
  MessageSquare,
  Plus,
  List,
  Users,
  Settings,
  Columns3,
} from "lucide-react";
import { useProject } from "../lib/project-context";

const FORGE = [
  { href: "/", label: "Fleet", icon: <LayoutGrid /> },
  { href: "/dashboard", label: "Dashboard", icon: <Gauge /> },
  { href: "/chat", label: "Sindri", icon: <MessageSquare /> },
  { href: "/plan", label: "Planejador", icon: <Sparkles /> },
  { href: "/mimir", label: "Mímir", icon: <BookText /> },
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
    <div style={{ padding: "0 12px 10px" }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--fg-dim)", margin: "0 0 5px 2px" }}>
        Ambiente
      </div>
      <select
        value={currentId}
        onChange={(e) => pick(e.target.value)}
        disabled={projects.length === 0}
        style={{
          width: "100%",
          padding: "7px 9px",
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--bg-subtle, transparent)",
          color: "inherit",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {projects.length === 0 && <option value="">— sem projetos —</option>}
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
  { href: "/connect", label: "Connect", icon: <Plus /> },
  { href: "/history", label: "History", icon: <List /> },
  { href: "/users", label: "Users", icon: <Users /> },
  { href: "/settings", label: "Settings", icon: <Settings /> },
] as const;

type SidebarUserProps = { name: string; role?: string; authDisabled: boolean };

export default function Sidebar({ user }: { user?: SidebarUserProps }) {
  const path = usePathname();
  const { currentId } = useProject();
  const isActive = (href: string) =>
    href === "/" ? path === "/" : path.startsWith(href);

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

      <ProjectSwitcher />

      <Nav>
        <NavGroup label="Forge">
          {/* Fleet (all projects), then Quadro = the current project's board
              (Huginn discovery + kanban), then the rest. */}
          <NavLink as={Link} href="/" icon={<LayoutGrid />} active={isActive("/")}>
            Fleet
          </NavLink>
          <NavLink
            as={Link}
            href={currentId ? `/projects/${currentId}` : "/"}
            icon={<Columns3 />}
            active={path.startsWith("/projects")}
          >
            Quadro
          </NavLink>
          {FORGE.filter((n) => n.href !== "/").map((n) => (
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
        <NavGroup label="Manage">
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
        <SidebarUser
          name={user.name}
          role={user.authDisabled ? "auth off" : user.role}
          action={
            <a href="/sign-out" className="ygg-sidebar-signout">
              sign out
            </a>
          }
        />
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
