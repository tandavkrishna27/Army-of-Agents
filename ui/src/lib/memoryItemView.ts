import type { MemoryItemCategory, MemoryItemLayer, MemoryItemStatus } from "@armyofagents/shared";
import type { Tone } from "../components/memory/MemoryChip";

/**
 * Status → tone for the quiet-chip atom. Five known statuses:
 * approved, pending, archived, rejected, draft.
 */
export const STATUS_TONE: Record<MemoryItemStatus, Tone> = {
  approved: "green",
  pending: "amber",
  archived: "slate",
  rejected: "magenta",
  draft: "slate",
};

/** Layer → tone. Same palette used by the layer headers in MemoryTree. */
export const LAYER_TONE: Record<MemoryItemLayer, Tone> = {
  identity: "indigo",
  domain: "teal",
  active_context: "amber",
  working: "magenta",
};

/** Optional: category → tone (used by viewer chips and item rows). */
export const CATEGORY_TONE: Record<MemoryItemCategory, Tone> = {
  decision: "indigo",
  reference: "teal",
  context: "magenta",
  insight: "amber",
  preference: "slate",
  procedure: "green",
  policy: "amber",
};

/**
 * Canonical short label for each layer. Consumers may append qualifiers
 * (e.g. "Identity (always in agent context)" inside the create-item dialog),
 * but the base label here is the source of truth — keeps capitalization
 * consistent across the viewer, list, tree, and dialogs.
 */
export const LAYER_LABELS: Record<MemoryItemLayer, string> = {
  identity: "Identity",
  domain: "Domain",
  active_context: "Active context",
  working: "Working",
};

// ---------------------------------------------------------------------------
// Pure display helpers — no I/O, no side effects
// ---------------------------------------------------------------------------

export type IconKind = "markdown" | "image" | "pdf" | "video" | "docx" | "generic";

type IconKindRow =
  | { kind: "memory_item"; content?: string | null }
  | { kind: "asset"; mimeType?: string | null; extractedText?: string | null };

/**
 * Derive an icon kind from a memory item or asset row.
 * Memory items always render as markdown; assets are classified by MIME type.
 */
export function pickIconKind(row: IconKindRow): IconKind {
  if (row.kind === "memory_item") return "markdown";
  const mt = row.mimeType ?? "";
  if (mt.startsWith("image/")) return "image";
  if (mt.startsWith("video/")) return "video";
  if (mt === "application/pdf") return "pdf";
  if (mt.includes("wordprocessingml")) return "docx";
  return "generic";
}

/**
 * Extract a plain-text body preview (≤200 chars) from a memory item or asset.
 * Strips a small set of markdown noise and collapses whitespace — not a full
 * markdown parser.
 */
export function pickSnippet(row: IconKindRow): string {
  const raw =
    row.kind === "memory_item"
      ? row.content ?? ""
      : (row as { kind: "asset"; mimeType?: string | null; extractedText?: string | null }).extractedText ?? "";
  // Order matters: strip link syntax before the emphasis/heading regex,
  // otherwise the URL parens leak through as "text(url)" in the snippet.
  const flat = raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/[#*_`>~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 200 ? flat.slice(0, 197).trimEnd() + "…" : flat;
}

/**
 * Format an ISO date string as a short relative label.
 * Returns one of: "today", "Nd", "Nw", "Nmo", "Ny", or "recently" (invalid input).
 */
export function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "recently";
  const d = Math.floor(ms / 86_400_000);
  if (d < 1) return "today";
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}
