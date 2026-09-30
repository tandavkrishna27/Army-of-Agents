import { MemoryItemCard, type MemoryItemCardData } from "./MemoryItemCard";

interface Props {
  rows: ReadonlyArray<MemoryItemCardData>;
  activeId: string | null;
  onSelect: (id: string, kind: "memory_item" | "asset") => void;
  onReindex?: (id: string) => void;
}

/**
 * CSS grid container that lays out a list of MemoryItemCards. Auto-fills the
 * available width with cards at a minimum of 220px each — adapts from a 1-col
 * narrow list at low widths up to 4-5 cards across at typical desktop widths.
 */
export function MemoryItemCardGrid({ rows, activeId, onSelect, onReindex }: Props) {
  return (
    <div
      className="grid gap-2.5 p-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
    >
      {rows.map((r) => (
        <MemoryItemCard
          key={`${r.kind}-${r.id}`}
          row={r}
          active={activeId === r.id}
          onSelect={onSelect}
          onReindex={onReindex}
        />
      ))}
    </div>
  );
}
