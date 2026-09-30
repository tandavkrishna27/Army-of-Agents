import { ChevronDown, FileText, Image as ImageIcon, Film, type LucideIcon } from "lucide-react";
import type { MemoryItemLayer, MemoryItemStatus, MemoryIndexStatus } from "@armyofagents/shared";
import { cn } from "@/lib/utils";
import { MemoryChip } from "./MemoryChip";
import { MemoryIndexBadge } from "./MemoryIndexBadge";
import {
  pickIconKind,
  formatRelative,
  STATUS_TONE,
  LAYER_TONE,
  LAYER_LABELS,
  type IconKind,
} from "../../lib/memoryItemView";

export interface MemoryItemTableRowData {
  kind: "memory_item" | "asset";
  id: string;
  title: string;
  layer?: string | null;
  status?: string | null;
  mimeType?: string | null;
  modifiedAt: string;
  /** Number of agent runs that used this item in their context package. */
  usedCount?: number;
  /** Approximate token count for memory items. */
  tokenEstimate?: number;
  /** Byte size for assets — rendered in the "Tokens" column for files. */
  sizeBytes?: number;
  /** Embedding index status. Only relevant for memory_item kind. */
  indexStatus?: MemoryIndexStatus | null;
}

export type MemoryTableSortColumn = "title" | "modifiedAt" | "usedCount";

interface Props {
  rows: ReadonlyArray<MemoryItemTableRowData>;
  activeId: string | null;
  onSelect: (id: string, kind: "memory_item" | "asset") => void;
  sortBy: MemoryTableSortColumn;
  sortDir: "asc" | "desc";
  onSortChange: (column: MemoryTableSortColumn) => void;
  onReindex?: (id: string) => void;
}

const ICON_FOR_KIND: Record<IconKind, LucideIcon> = {
  markdown: FileText,
  image: ImageIcon,
  video: Film,
  pdf: FileText,
  docx: FileText,
  generic: FileText,
};

function formatSize(bytes: number): string {
  // kB: round to whole number — typical file sizes are >10 kB, decimal adds no info.
  // MB: keep one decimal — values are often fractional and the precision matters.
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} kB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

interface ThProps {
  label: string;
  column?: MemoryTableSortColumn;
  sortBy: MemoryTableSortColumn;
  sortDir: "asc" | "desc";
  onSortChange: (column: MemoryTableSortColumn) => void;
  align?: "left" | "right";
  width?: string;
}

function Th({ label, column, sortBy, sortDir, onSortChange, align = "left", width }: ThProps) {
  const sortable = !!column;
  const active = sortable && sortBy === column;
  return (
    <th
      scope="col"
      onClick={sortable ? () => onSortChange(column!) : undefined}
      style={width ? { width } : undefined}
      className={cn(
        "px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-very-dim",
        "border-b border-border bg-card whitespace-nowrap",
        align === "right" && "text-right",
        sortable && "cursor-pointer hover:text-foreground",
      )}
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
    >
      {label}
      {active && (
        <ChevronDown
          aria-hidden
          className={cn("inline ml-1 size-3", sortDir === "asc" && "rotate-180")}
        />
      )}
    </th>
  );
}

export function MemoryItemTable({ rows, activeId, onSelect, sortBy, sortDir, onSortChange, onReindex }: Props) {
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr>
          <Th label="Name" column="title" width="36%" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} />
          <Th label="Layer" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} />
          <Th label="Status" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} />
          <Th label="Index" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} />
          <Th label="Modified" column="modifiedAt" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} />
          <Th label="Used" column="usedCount" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} />
          <Th label="Tokens" align="right" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const active = r.id === activeId;
          const Icon = ICON_FOR_KIND[pickIconKind(r)];
          const tokensCell =
            r.kind === "memory_item"
              ? (r.tokenEstimate != null ? `~${r.tokenEstimate}` : "—")
              : (r.sizeBytes != null ? formatSize(r.sizeBytes) : "—");
          return (
            <tr
              key={`${r.kind}-${r.id}`}
              data-active={active}
              tabIndex={0}
              onClick={() => onSelect(r.id, r.kind)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(r.id, r.kind);
                }
              }}
              className={cn(
                "cursor-pointer border-b border-border-soft",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-focus-ring",
                active
                  ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
                  : "hover:bg-white/[0.04]",
              )}
            >
              <td className={cn("max-w-[280px] truncate px-4 py-2", active && "font-medium")}>
                <Icon
                  aria-hidden
                  className={cn(
                    "inline mr-2 size-3.5 align-[-2px]",
                    active ? "text-[hsl(15_60%_75%)]" : "text-muted-foreground",
                  )}
                />
                {r.title}
              </td>
              <td className="px-4 py-2">
                {r.layer && (
                  <MemoryChip
                    label={LAYER_LABELS[r.layer as MemoryItemLayer] ?? r.layer}
                    tone={LAYER_TONE[r.layer as MemoryItemLayer] ?? "slate"}
                  />
                )}
              </td>
              <td className="px-4 py-2">
                {r.status ? (
                  <MemoryChip
                    label={r.status}
                    tone={STATUS_TONE[r.status as MemoryItemStatus] ?? "slate"}
                  />
                ) : r.kind === "asset" ? (
                  <span className="text-very-dim">file</span>
                ) : null}
              </td>
              <td className="px-4 py-2">
                {r.indexStatus ? (
                  <MemoryIndexBadge
                    status={r.indexStatus}
                    onReindex={onReindex ? () => onReindex(r.id) : undefined}
                  />
                ) : null}
              </td>
              <td className="px-4 py-2">{formatRelative(r.modifiedAt)}</td>
              <td className="px-4 py-2 tabular-nums">
                {r.usedCount != null ? `${r.usedCount}×` : "—"}
              </td>
              <td className="px-4 py-2 text-right font-mono tabular-nums">
                {tokensCell}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
