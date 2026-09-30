/**
 * CockpitDoneTodayCard — Opt-in cockpit card.
 *
 * Presentational only — receives items from the shared /cockpit query.
 * Returns null when items is empty so the card doesn't mount needlessly.
 */

import type { CockpitDoneTodayItem } from "@armyofagents/shared";

export function CockpitDoneTodayCard({
  items,
  onOpenTask,
}: {
  items: CockpitDoneTodayItem[];
  onOpenTask?: (issueId: string, title: string) => void;
}) {
  if (items.length === 0) return null;

  // Phase 5B: Internal <header> removed — title/icon/count now live in the
  // CockpitSection trigger in CommanderCockpitPanel. Card renders only body rows.
  return (
    <div data-testid="cockpit-card-doneToday">
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li
            key={item.id}
            className="group flex items-center gap-1 truncate rounded px-1 py-1 text-xs hover:bg-muted/50"
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left"
              onClick={() => onOpenTask?.(item.id, item.title)}
            >
              {item.identifier && (
                <span className="mr-1 shrink-0 text-[10px] text-muted-foreground">
                  {item.identifier}
                </span>
              )}
              <span className="truncate font-medium">{item.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
