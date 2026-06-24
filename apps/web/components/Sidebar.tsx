"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
  Plus,
  List,
  Users,
  Settings,
} from "lucide-react";

const FORGE = [
  { href: "/", label: "Fleet", icon: <LayoutGrid /> },
  { href: "/dashboard", label: "Dashboard", icon: <Gauge /> },
  { href: "/plan", label: "Planejador", icon: <Sparkles /> },
  { href: "/mimir", label: "Mímir", icon: <BookText /> },
] as const;

const MANAGE = [
  { href: "/connect", label: "Connect", icon: <Plus /> },
  { href: "/history", label: "History", icon: <List /> },
  { href: "/users", label: "Users", icon: <Users /> },
  { href: "/settings", label: "Settings", icon: <Settings /> },
] as const;

type SidebarUserProps = { name: string; role?: string; authDisabled: boolean };

export default function Sidebar({ user }: { user?: SidebarUserProps }) {
  const path = usePathname();
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

      <Nav>
        <NavGroup label="Forge">
          {FORGE.map((n) => (
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
