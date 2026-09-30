/**
 * Shared syntax-highlighting helper for the content viewers (P3.2).
 *
 * ## Bundle discipline
 * We import `highlight.js/lib/core` (the tokenizer engine, no grammars) and
 * register only a CURATED subset of ~23 common languages below. Importing the
 * default `highlight.js` entrypoint would pull in ALL ~190 bundled grammars
 * (~1MB+ minified). By registering a hand-picked list against the core build,
 * Vite tree-shakes every grammar we do not import, keeping the highlighter to
 * the languages a work-product viewer actually encounters.
 *
 * ## Static (not dynamic) import
 * The Phase-3 plan leaned toward dynamic-importing the highlighter to keep it
 * off the initial bundle, but {@link highlightToHtml} must return `{ html }`
 * synchronously to feed `dangerouslySetInnerHTML` — an async import would force
 * loading state/flash plumbing into every viewer. core+curated-subset is small
 * (far lighter than mermaid, which we DO dynamic-import) and the viewers are
 * already route-split off the app entry, so a static import is the right call.
 *
 * ## XSS safety
 * `hljs.highlight(...).value` returns HTML in which the ORIGINAL CODE TEXT is
 * entity-escaped — only highlight.js's own `<span class="hljs-*">` wrappers are
 * real markup. So injecting the result via `dangerouslySetInnerHTML` cannot
 * execute code embedded in the source: e.g.
 * `hljs.highlight("<script>", { language: "javascript" }).value` contains
 * `&lt;script&gt;`, never a live `<script>` tag. The degrade path escapes the
 * text ourselves, so every branch of {@link highlightToHtml} yields safe HTML.
 *
 * ## Never throws / no auto-detect
 * `highlightToHtml` wraps everything in try/catch and falls back to
 * entity-escaped plain text on any error. An absent OR unregistered language
 * degrades to escaped plain text — we never auto-detect (which would spray a
 * plain `.txt` note with guessed token colors) and never silently guess a
 * different grammar for an explicit request.
 */
import hljs from "highlight.js/lib/core";

import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * The curated language subset. Registering a grammar also registers the aliases
 * declared inside it (e.g. `javascript` → `js`/`jsx`, `xml` → `html`/`svg`,
 * `csharp` → `cs`, `dockerfile` → `docker`), so `hljs.getLanguage` resolves more
 * ids than the keys listed here.
 */
const LANGUAGES: Record<string, LanguageFn> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  php,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  typescript,
  xml,
  yaml,
};

type LanguageFn = Parameters<typeof hljs.registerLanguage>[1];

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  for (const [name, fn] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(name, fn);
  }
  registered = true;
}

// Register eagerly on module load so `hljs.getLanguage` works synchronously.
ensureRegistered();

/**
 * File-extension → highlight.js language id. Extensions with no code meaning
 * (`.txt`, `.log`, ...) and unknown extensions return `undefined`, which
 * {@link highlightToHtml} renders as escaped plain text (no auto-detect). JSX/
 * TSX collapse to javascript/typescript (highlight.js's js/ts grammars handle
 * the JSX superset).
 */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  pyw: "python",
  json: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  html: "xml",
  htm: "xml",
  xml: "xml",
  xhtml: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  sass: "scss",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  toml: "ini",
};

/**
 * Resolve a highlight.js language id from a filename's extension.
 * Returns `undefined` for unknown/plain extensions and for missing filenames.
 * Files literally named `Dockerfile` (no extension) resolve to `dockerfile`.
 */
export function languageForFilename(filename?: string | null): string | undefined {
  if (!filename) return undefined;
  const name = filename.trim().toLowerCase();
  if (name === "dockerfile" || name.endsWith(".dockerfile") || name.endsWith("/dockerfile")) {
    return "dockerfile";
  }
  const lastDot = name.lastIndexOf(".");
  if (lastDot === -1 || lastDot === name.length - 1) return undefined;
  const ext = name.slice(lastDot + 1);
  return EXTENSION_TO_LANGUAGE[ext];
}

/** Entity-escape text so it is inert when injected via `dangerouslySetInnerHTML`. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface HighlightResult {
  /** HTML-safe string: escaped code text wrapped in `<span class="hljs-*">` tokens. */
  html: string;
  /** The language actually used, or `null` when the output is plain escaped text. */
  language: string | null;
}

/**
 * Highlight `code` to HTML-escaped, token-wrapped markup.
 *
 * - A registered `language` → highlight with that grammar.
 * - An absent OR unregistered `language` → escaped plain text. We deliberately
 *   do NOT auto-detect: guessing a grammar for a plain `.txt`/`.log`/unknown
 *   file would spray it with token colors, and auto-detection is the most
 *   expensive path for exactly the files that benefit least.
 * - Any thrown error → escaped plain text.
 *
 * The return is always safe to inject with `dangerouslySetInnerHTML`.
 */
export function highlightToHtml(code: string, language?: string): HighlightResult {
  try {
    const normalized = language?.trim().toLowerCase();
    if (normalized && hljs.getLanguage(normalized)) {
      const result = hljs.highlight(code, { language: normalized, ignoreIllegals: true });
      return { html: result.value, language: result.language ?? normalized };
    }
    // Absent or unregistered language: degrade to escaped plain text.
    return { html: escapeHtml(code), language: null };
  } catch {
    return { html: escapeHtml(code), language: null };
  }
}
