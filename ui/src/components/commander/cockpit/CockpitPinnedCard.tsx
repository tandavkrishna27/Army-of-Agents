/**
 * CockpitPinnedCard — Phase 3d.
 *
 * Presentational only — no hook inside. All callbacks are optional props.
 * Mirrors the card chrome and list row patterns from CockpitReviewCard.
 */

import { PinOff } from "lucide-react";
import type { CockpitPinnedEntityType, CockpitPinnedItem } from "@armyofagents/shared";

// Chip label map for entity type
const TYPE_LABELS: Record<CockpitPinnedEntityType, string> = {
  task: "Task",
  artifact: "Artifact",
  goal: "Goal",
};

// Type-agnostic status humanizer ("in_review" → "In review", "at_risk" → "At risk").
// The card mixes task/artifact/goal statuses, so no single label map covers all three.
function humanizeStatus(status: string): string {
  const s = status.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function CockpitPinnedCard({
  items,
  onOpenTask,
  onOpenArtifact,
  onOpenFullPage,
  onUnpin,
}: {
  items: CockpitPinnedItem[];
  onOpenTask?: (issueId: string, title: string) => void;
  onOpenArtifact?: (artifactId: string, title: string) => void;
  onOpenFullPage?: (href: string) => void;
  onUnpin?: (entityType: CockpitPinnedEntityType, entityId: string) => void;
}) {
  if (items.length === 0) return null;

  function handleRowClick(item: CockpitPinnedItem) {
    if (item.entityType === "task") {
      onOpenTask?.(item.entityId, item.title);
    } else if (item.entityType === "artifact") {
      onOpenArtifact?.(item.entityId, item.title);
    } else {
      onOpenFullPage?.(`/goals/${item.entityId}`);
    }
  }

  // Phase 5B: Internal <header> removed — title/icon/count now live in the
  // CockpitSection trigger in CommanderCockpitPanel. Card renders only body rows.
  return (
    <div data-testid="cockpit-card-pinned">
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li
            key={`${item.entityType}:${item.entityId}`}
            className="group flex items-center gap-1 truncate rounded px-1 py-1 text-xs hover:bg-muted/50"
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left"
              onClick={() => handleRowClick(item)}
            >
              {item.identifier && (
                <span className="mr-1 shrink-0 text-[10px] text-muted-foreground">
                  {item.identifier}
                </span>
              )}
              <span className="truncate font-medium">{item.title}</span>
            </button>
            <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
              {TYPE_LABELS[item.entityType]}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{humanizeStatus(item.status)}</span>
            {onUnpin && (
              <button
                type="button"
                aria-label="Unpin"
                className="ml-1 hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                onClick={() => onUnpin(item.entityType, item.entityId)}
              >
                <PinOff className="size-3" aria-hidden />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
