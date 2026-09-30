/**
 * CockpitProactiveFindingsCard — Opt-in cockpit card.
 *
 * Presentational only — receives items from the shared /cockpit query.
 * Returns null when items is empty so the card doesn't mount needlessly.
 *
 * Items are the Commander's recent unread proactive check notifications.
 * Click: if the item has a relatedEntity, navigate to /inbox; otherwise
 * open Commander chat pre-filled with the finding title.
 */

import type { CockpitProactiveItem } from "@armyofagents/shared";

export function CockpitProactiveFindingsCard({
  items,
  onOpenFullPage,
  onOpenTask,
  onAsk,
}: {
  items: CockpitProactiveItem[];
  onOpenFullPage?: (href: string) => void;
  onOpenTask?: (issueId: string, title: string) => void;
  onAsk?: (text: string) => void;
}) {
  if (items.length === 0) return null;

  // Phase 5B: Internal <header> removed — title/icon/count now live in the
  // CockpitSection trigger in CommanderCockpitPanel. Card renders only body rows.
  return (
    <div data-testid="cockpit-card-proactiveFindings">
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li
            key={item.id}
            className="group flex items-center gap-1 truncate rounded px-1 py-1 text-xs hover:bg-muted/50"
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left"
              onClick={() => {
                if (item.relatedEntityType && item.relatedEntityId) {
                  if (item.relatedEntityType === "task" || item.relatedEntityType === "issue") {
                    onOpenTask?.(item.relatedEntityId, item.title);
                  } else {
                    onOpenFullPage?.("/inbox");
                  }
                } else {
                  onAsk?.(item.title);
                }
              }}
            >
              <span className="truncate font-medium">{item.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
