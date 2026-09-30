import type { UniverseAttentionEntry, UniverseAttentionResponse } from "@armyofagents/shared";

const CATEGORIES = [
  ["needsYou", "Needs you"],
  ["ready", "Ready"],
  ["comingUp", "Coming up"],
] as const;

export function AttentionRail({attention, selectedId, onSelect, onViewAll, onFinish, finishing}: {
  attention: UniverseAttentionResponse;
  selectedId?: string | null;
  onSelect: (entry: UniverseAttentionEntry) => void;
  onViewAll: () => void;
  onFinish?: () => void;
  finishing?: boolean;
}) {
  const nonempty = CATEGORIES.filter(([key]) => attention[key].length > 0);
  if (!nonempty.length) return null;
  return <aside className="universe-attention-rail" aria-label="Attention">
    {nonempty.map(([key, label]) => <section key={key} aria-label={label}>
      <h2>{label}</h2>
      {attention[key].slice(0, 5).map(entry => <button type="button" key={entry.id}
        aria-pressed={selectedId === entry.id} onClick={() => onSelect(entry)}>
        <strong>{entry.title}</strong>{entry.summary && <span>{entry.summary}</span>}
      </button>)}
      {attention[key].length > 5 && <button type="button" onClick={onViewAll}>View all {label.toLowerCase()}</button>}
    </section>)}
    {onFinish && <button type="button" className="universe-attention-finish" disabled={finishing} onClick={onFinish}>
      {finishing ? "Finishing…" : "Finish review"}
    </button>}
  </aside>;
}
