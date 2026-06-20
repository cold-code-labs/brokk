"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type React from "react";

const NAV = [
  { href: "/", label: "Dashboard", icon: "⚡" },
  { href: "/kanban", label: "Kanban", icon: "📋" },
];

export default function Sidebar() {
  const path = usePathname();

  return (
    <nav style={sidebarStyle}>
      {/* Logo */}
      <div style={logoStyle}>
        <span style={{ fontSize: 22 }}>🔨</span>
        <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.3, color: "#e6e8ee" }}>
          Brokk
        </span>
      </div>

      {/* Nav items */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "10px 8px" }}>
        {NAV.map((item) => {
          const active = path === item.href;
          return (
            <Link key={item.href} href={item.href} style={navItemStyle(active)}>
              <span style={{ fontSize: 14, lineHeight: 1 }}>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const sidebarStyle: React.CSSProperties = {
  width: 216,
  minHeight: "100vh",
  background: "#07080f",
  borderRight: "1px solid #1c212c",
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
};

const logoStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "18px 16px 16px",
  borderBottom: "1px solid #1c212c",
};

function navItemStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 7,
    textDecoration: "none",
    fontSize: 13.5,
    fontWeight: active ? 600 : 400,
    color: active ? "#e6e8ee" : "#6b7585",
    background: active ? "#151a26" : "transparent",
  };
}
