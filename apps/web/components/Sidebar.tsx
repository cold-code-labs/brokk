"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Fleet", icon: "▦", desc: "All repos & queues" },
  { href: "/connect", label: "Connect", icon: "＋", desc: "Add CCL repos" },
  { href: "/plan", label: "Planejador", icon: "✦", desc: "Intent → cards → PR" },
  { href: "/mimir", label: "Mímir", icon: "✧", desc: "Prompts & refine" },
  { href: "/history", label: "History", icon: "≡", desc: "All tasks & PRs" },
  { href: "/users", label: "Users", icon: "◐", desc: "Seats & subscriptions" },
  { href: "/settings", label: "Settings", icon: "⚙", desc: "Project & runner" },
] as const;

type SidebarUser = { name: string; role?: string; authDisabled: boolean };

export default function Sidebar({ user }: { user?: SidebarUser }) {
  const path = usePathname();
  return (
    <nav style={rail}>
      <div style={{ padding: "22px 18px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brokk.svg" alt="Brokk" width={22} height={31} style={{ display: "block" }} />
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: -0.4 }}>Brokk</span>
        </div>
        <p style={{ margin: "4px 0 0 31px", fontSize: 11, color: "#5c6575" }}>the mega forge</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 10px" }}>
        {NAV.map((n) => {
          const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
          return (
            <Link key={n.href} href={n.href} style={item(active)}>
              <span style={{ fontSize: 15, width: 18, textAlign: "center", opacity: active ? 1 : 0.7 }}>{n.icon}</span>
              <span style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 13.5, fontWeight: active ? 600 : 500 }}>{n.label}</span>
                <span style={{ fontSize: 10.5, color: "#5c6575" }}>{n.desc}</span>
              </span>
            </Link>
          );
        })}
      </div>

      {user ? (
        <div style={{ marginTop: "auto", padding: "12px 16px", borderTop: "1px solid #161b24" }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "#cfd4de" }}>{user.name}</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 3 }}>
            <span style={{ fontSize: 10.5, color: "#5c6575" }}>
              {user.role ?? ""}
              {user.authDisabled ? "auth off" : ""}
            </span>
            <a href="/sign-out" style={{ fontSize: 11, color: "#9aa3b2", textDecoration: "none" }}>
              sign out
            </a>
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: user ? 0 : "auto", padding: 16, borderTop: "1px solid #161b24" }}>
        <a href="https://github.com/cold-code-labs/brokk" target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#5c6575", textDecoration: "none" }}>
          cold-code-labs/brokk ↗
        </a>
      </div>
    </nav>
  );
}

const rail: React.CSSProperties = {
  width: 220,
  flexShrink: 0,
  height: "100vh",
  position: "sticky",
  top: 0,
  display: "flex",
  flexDirection: "column",
  background: "#0a0c11",
  borderRight: "1px solid #161b24",
};

function item(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 11px",
    borderRadius: 9,
    textDecoration: "none",
    color: active ? "#e6e8ee" : "#9aa3b2",
    background: active ? "#161c28" : "transparent",
    border: `1px solid ${active ? "#222b3a" : "transparent"}`,
  };
}
