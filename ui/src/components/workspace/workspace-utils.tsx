/**
 * Shared workspace utilities — extracted from RunBlock.tsx and WorkspacePreviewPanel.tsx.
 * Single source of truth for formatting, icons, and label helpers used across workspace components.
 */

import { Loader2, Check, X as XIcon, FileText, FileCode, FileImage, File } from "lucide-react";
import type { DetectedOutput } from "@armyofagents/shared";

/* ── Duration ──────────────────────────────────────────────────────────────── */

export function formatDuration(start: string | null, end: string | null, nowMs = Date.now()): string {
  if (!start) return "";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : nowMs;
  const diffSec = Math.round((e - s) / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const min = Math.floor(diffSec / 60);
  const sec = diffSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

/* ── Run status icon ───────────────────────────────────────────────────────── */

export function RunStatusIcon({ status }: { status: string }) {
  if (status === "running" || status === "in_progress") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-500" />;
  }
  if (status === "succeeded" || status === "completed") {
    return <Check className="h-3.5 w-3.5 text-green-500" />;
  }
  if (status === "failed" || status === "error") {
    return <XIcon className="h-3.5 w-3.5 text-red-500" />;
  }
  return <span className="h-3.5 w-3.5 rounded-full bg-muted-foreground/30 inline-block" />;
}

/* ── Run status border color (for timeline cards) ──────────────────────────── */

export function runStatusBorderColor(status: string): string {
  if (status === "running" || status === "in_progress") return "border-l-cyan-500";
  if (status === "succeeded" || status === "completed") return "border-l-green-500";
  if (status === "failed" || status === "error") return "border-l-red-500";
  return "border-l-muted-foreground/30";
}

/* ── File helpers ──────────────────────────────────────────────────────────── */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileIcon(contentType: string): typeof FileText {
  if (contentType.startsWith("image/")) return FileImage;
  if (contentType.includes("javascript") || contentType.includes("typescript") || contentType.includes("json"))
    return FileCode;
  if (contentType.startsWith("text/")) return FileText;
  return File;
}

/* ── Source labels (for DetectedOutput badges) ─────────────────────────────── */

export function sourceLabel(source: string): { text: string; className: string } {
  switch (source) {
    case "git_diff":
      return { text: "Modified", className: "bg-green-500/10 text-green-600" };
    case "workspace_scan":
      return { text: "Detected", className: "bg-blue-500/10 text-blue-600" };
    case "adapter_provided":
      return { text: "Provided", className: "bg-purple-500/10 text-purple-600" };
    default:
      return { text: source, className: "bg-muted text-muted-foreground" };
  }
}

/* ── DetectedOutput aggregation ────────────────────────────────────────────── */

export function summarizeOutputs(outputs: DetectedOutput[]): { fileCount: number; totalBytes: number } {
  return {
    fileCount: outputs.length,
    totalBytes: outputs.reduce((sum, o) => sum + (o.byteSize ?? 0), 0),
  };
}
