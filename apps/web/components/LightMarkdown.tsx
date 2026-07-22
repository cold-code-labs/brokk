/** Minimal markdown for task drawers — bold, code, lists, blank lines. No deps. */
import type { ReactNode } from "react";

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0]!;
    if (token.startsWith("`")) {
      parts.push(
        <code key={key++} style={{ fontFamily: "var(--font-mono, monospace)", fontSize: "0.92em" }}>
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Render a small markdown subset as readable blocks (not a full MD engine). */
export function LightMarkdown({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }

    // Heading: entire line is **Title**
    const heading = /^\*\*(.+)\*\*$/.exec(line.trim());
    if (heading) {
      blocks.push(
        <div
          key={key++}
          style={{
            fontSize: 11,
            fontWeight: 650,
            letterSpacing: 0.04,
            textTransform: "uppercase",
            color: "var(--fg-dim)",
            marginTop: blocks.length ? 12 : 0,
            marginBottom: 4,
          }}
        >
          {heading[1]}
        </div>,
      );
      i++;
      continue;
    }

    // Bullet / numbered list
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} style={{ margin: "4px 0 8px", paddingLeft: 18, fontSize: 13, lineHeight: 1.45 }}>
          {items.map((item, j) => (
            <li key={j} style={{ marginBottom: 3 }}>
              {inline(item)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // Paragraph (consume consecutive non-empty non-list non-heading lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^\*\*(.+)\*\*$/.test((lines[i] ?? "").trim()) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? "")
    ) {
      para.push(lines[i] ?? "");
      i++;
    }
    blocks.push(
      <p key={key++} style={{ margin: "0 0 8px", fontSize: 13, lineHeight: 1.45 }}>
        {inline(para.join(" "))}
      </p>,
    );
  }

  return (
    <div className={className} style={{ color: "var(--fg-dim)" }}>
      {blocks}
    </div>
  );
}
