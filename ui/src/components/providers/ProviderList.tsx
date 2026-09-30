/**
 * The Providers tab's left rail — a fixed tertiary list (third nav level under
 * the primary sidebar and the settings secondary nav). Presentational: it owns
 * no fetching and no selection state; the section supplies both.
 *
 * The status dot uses `deriveProviderBadge`, the SAME verdict the detail card's
 * pill shows, so the rail and the card can never disagree for one row.
 */
import type { ProviderId } from "@armyofagents/shared";
import type { ProviderStatusRow } from "../../api/providers";
import { deriveProviderBadge, TONE_DOT } from "./ProviderReadinessCard";
import { cn } from "@/lib/utils";

export interface ProviderListProps {
  rows: ProviderStatusRow[];
  selectedId: ProviderId | null;
  onSelect(id: ProviderId): void;
}

export function ProviderList({ rows, selectedId, onSelect }: ProviderListProps) {
  const inUse = rows.filter((r) => r.agents.length > 0);
  const available = rows.filter((r) => r.agents.length === 0);
  return (
    <nav
      className="flex flex-col gap-0.5 rounded-xl border border-border bg-card p-2 md:h-full md:min-h-0 md:overflow-y-auto"
      data-testid="provider-list"
      aria-label="Providers"
    >
      <ProviderGroup label="In use" items={inUse} selectedId={selectedId} onSelect={onSelect} />
      <ProviderGroup label="Available" items={available} selectedId={selectedId} onSelect={onSelect} />
    </nav>
  );
}

function ProviderGroup({
  label,
  items,
  selectedId,
  onSelect,
}: {
  label: string;
  items: ProviderStatusRow[];
  selectedId: ProviderId | null;
  onSelect(id: ProviderId): void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/60">
        {label}
      </div>
      {items.map((row) => (
        <ProviderListItem
          key={row.descriptor.id}
          row={row}
          selected={row.descriptor.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function ProviderListItem({
  row,
  selected,
  onSelect,
}: {
  row: ProviderStatusRow;
  selected: boolean;
  onSelect(id: ProviderId): void;
}) {
  const { descriptor } = row;
  const badge = deriveProviderBadge(row);
  return (
    <button
      type="button"
      data-testid="provider-list-item"
      data-provider={descriptor.id}
      aria-selected={selected}
      onClick={() => onSelect(descriptor.id)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
        selected ? "bg-background ring-1 ring-inset ring-border" : "hover:bg-white/[0.04]",
      )}
    >
      <span
        data-testid="provider-list-dot"
        className={cn("size-2 shrink-0 rounded-full", TONE_DOT[badge.tone])}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{descriptor.label}</span>
    </button>
  );
}
