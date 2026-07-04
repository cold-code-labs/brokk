// ─────────────────────────────────────────────────────────────────────────────
// Read-only syntax highlighter for the file viewer. Shiki (VS Code's own
// TextMate grammars + themes) with the JavaScript regex engine — no wasm — and a
// curated language set, so this whole module is a small chunk the FileViewer
// dynamic-imports only when a file is opened. Dual light/dark themes ride the
// app's next-themes `html.dark` toggle (see .fv-code CSS in globals.css).
// ─────────────────────────────────────────────────────────────────────────────

import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Extension → shiki lang id. Every value must be a grammar loaded in loadLangs().
const BY_EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  json: "json", json5: "jsonc", jsonc: "jsonc",
  css: "css", scss: "scss", sass: "scss",
  html: "html", htm: "html", xml: "xml", svg: "xml",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  yml: "yaml", yaml: "yaml",
  toml: "toml",
  sh: "bash", bash: "bash", zsh: "bash",
  py: "python",
  sql: "sql",
  graphql: "graphql", gql: "graphql",
  prisma: "prisma",
  ini: "ini", cfg: "ini", conf: "ini", env: "ini",
  diff: "diff", patch: "diff",
  dockerfile: "docker",
};
// Whole-filename specials (no useful extension).
const BY_NAME: Record<string, string> = {
  dockerfile: "docker",
  ".gitignore": "ini",
  ".dockerignore": "ini",
  ".npmrc": "ini",
  ".env": "ini",
};

/** Fire the per-language dynamic imports (deferred to first highlight, so nothing
 *  loads until the code tab is actually used). */
function loadLangs() {
  return [
    import("@shikijs/langs/typescript"),
    import("@shikijs/langs/tsx"),
    import("@shikijs/langs/javascript"),
    import("@shikijs/langs/jsx"),
    import("@shikijs/langs/json"),
    import("@shikijs/langs/jsonc"),
    import("@shikijs/langs/css"),
    import("@shikijs/langs/scss"),
    import("@shikijs/langs/html"),
    import("@shikijs/langs/xml"),
    import("@shikijs/langs/markdown"),
    import("@shikijs/langs/yaml"),
    import("@shikijs/langs/toml"),
    import("@shikijs/langs/bash"),
    import("@shikijs/langs/python"),
    import("@shikijs/langs/sql"),
    import("@shikijs/langs/graphql"),
    import("@shikijs/langs/prisma"),
    import("@shikijs/langs/ini"),
    import("@shikijs/langs/diff"),
    import("@shikijs/langs/docker"),
  ];
}

const KNOWN = new Set([
  "typescript", "tsx", "javascript", "jsx", "json", "jsonc", "css", "scss", "html",
  "xml", "markdown", "yaml", "toml", "bash", "python", "sql", "graphql", "prisma",
  "ini", "diff", "docker",
]);

let hlPromise: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  if (!hlPromise) {
    hlPromise = createHighlighterCore({
      themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
      langs: loadLangs(),
      // forgiving: a grammar rule the JS engine can't compile is skipped, not thrown —
      // so one exotic pattern never blanks the whole file.
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return hlPromise;
}

/** shiki lang id for a filename, or null when we have no grammar for it. */
export function langForFile(name: string): string | null {
  const base = (name.split("/").pop() ?? name).toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base];
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base;
  const lang = BY_EXT[ext];
  return lang && KNOWN.has(lang) ? lang : null;
}

/** Highlight `code` into Shiki HTML (dual light/dark via CSS vars), or null when
 *  the file has no known grammar (caller falls back to a plain <pre>). Read-only. */
export async function highlight(code: string, filename: string): Promise<string | null> {
  const lang = langForFile(filename);
  if (!lang) return null;
  const hl = await getHighlighter();
  return hl.codeToHtml(code, {
    lang,
    themes: { light: "github-light", dark: "github-dark" },
    // Emit BOTH themes as CSS vars (--shiki / --shiki-dark) with no baked-in color,
    // so globals.css can flip them on `html.dark` to follow the app theme.
    defaultColor: false,
  });
}
