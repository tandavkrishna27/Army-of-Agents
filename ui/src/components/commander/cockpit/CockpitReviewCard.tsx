import { MessageSquare, Pin } from "lucide-react";
import type { CockpitPinnedEntityType, CockpitTaskItem, CommanderInputRef } from "@armyofagents/shared";
import { setCommanderRefDragData } from "./cockpitReferenceDrag";
import { COCKPIT_DRAGGABLE_ROW_CLASS } from "./cockpitRowStyles";

// Phase 5B: Internal <header> removed — title/icon/count now live in the
// CockpitSection trigger in CommanderCockpitPanel. Card renders only body rows.
function taskRef(item: CockpitTaskItem): CommanderInputRef {
  return {
    v: 1,
    kind: "task",
    id: item.id,
    label: item.identifier ? `${item.identifier} ${item.title}` : item.title,
    route: `/issues/${item.id}`,
    detail: `status=${item.status}`,
  };
}

function reviewPrompt(item: CockpitTaskItem) {
  return `About ${item.identifier ?? item.title} - what changed and should I approve it?`;
}

export function CockpitReviewCard({
  items,
  onOpenTask,
  onAsk,
  onReference,
  onPin,
  total = items.length,
  onViewAll,
}: {
  items: CockpitTaskItem[];
  onOpenTask?: (issueId: string, title: string) => void;
  onAsk?: (text: string) => void;
  onReference?: (ref: CommanderInputRef, suggestedPrompt?: string) => void;
  onPin?: (entityType: CockpitPinnedEntityType, entityId: string) => void;
  total?: number;
  onViewAll?: () => void;
}) {
  if (items.length === 0) return null;

  return (
    <div data-testid="cockpit-card-review">
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li
            key={item.id}
            draggable
            onDragStart={(event) => setCommanderRefDragData(event.dataTransfer, taskRef(item), reviewPrompt(item))}
            className={`group flex items-center gap-1 truncate rounded px-1 py-1 text-xs ${COCKPIT_DRAGGABLE_ROW_CLASS}`}
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
              {item.responsibility?.label && (
                <span className="ml-1 text-[10px] text-muted-foreground">
                  {item.responsibility.label}
                </span>
              )}
            </button>
            {onAsk && (
              <button
                type="button"
                aria-label="Ask Commander about this"
                className="ml-1 hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                onClick={() => {
                  const prompt = reviewPrompt(item);
                  const ref = taskRef(item);
                  if (onReference) onReference(ref, prompt);
                  else onAsk(prompt);
                }}
              >
                <MessageSquare className="size-3" aria-hidden />
              </button>
            )}
            {onPin && (
              <button
                type="button"
                aria-label="Pin"
                className="ml-1 hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                onClick={() => onPin("task", item.id)}
              >
                <Pin className="size-3" aria-hidden />
              </button>
            )}
          </li>
        ))}
      </ul>
      {total > items.length && onViewAll && (
        <button
          type="button"
          className="mt-1 px-1 py-1 text-[10px] font-medium text-brand hover:underline"
          onClick={onViewAll}
        >
          View all Awaiting Review
        </button>
      )}
    </div>
  );
}
