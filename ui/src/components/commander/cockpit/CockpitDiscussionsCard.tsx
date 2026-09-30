import { ExternalLink, MessageSquare as MessageSquareIcon } from "lucide-react";
import type { CockpitDiscussionItem, CommanderInputRef } from "@armyofagents/shared";
import { setCommanderRefDragData } from "./cockpitReferenceDrag";
import { COCKPIT_DRAGGABLE_ROW_CLASS } from "./cockpitRowStyles";

function discussionTitle(item: CockpitDiscussionItem) {
  return item.title ?? "Untitled discussion";
}

function discussionRef(item: CockpitDiscussionItem): CommanderInputRef {
  return {
    v: 1,
    kind: "discussion",
    id: item.id,
    label: discussionTitle(item),
    route: `/discussions/${item.id}`,
    detail: `reason=${item.reason}; pending=${item.pendingItemCount}`,
  };
}

function discussionPrompt(item: CockpitDiscussionItem) {
  return `Summarize the discussion "${discussionTitle(item)}" and what action items are pending approval.`;
}

export function CockpitDiscussionsCard({
  items,
  onOpenFullPage,
  onOpenReference,
  onAsk,
  onReference,
}: {
  items: CockpitDiscussionItem[];
  onOpenFullPage?: (href: string) => void;
  onOpenReference?: (ref: CommanderInputRef) => void;
  onAsk?: (text: string) => void;
  onReference?: (ref: CommanderInputRef, suggestedPrompt?: string) => void;
}) {
  if (items.length === 0) return null;

  // Phase 5B: Internal <header> removed — title/icon/count now live in the
  // CockpitSection trigger in CommanderCockpitPanel. Card renders only body rows.
  return (
    <div data-testid="cockpit-card-discussions">
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li
            key={item.id}
            draggable
            onDragStart={(event) => setCommanderRefDragData(event.dataTransfer, discussionRef(item), discussionPrompt(item))}
            className={`group flex items-center gap-1 truncate rounded px-1 py-1 text-xs ${COCKPIT_DRAGGABLE_ROW_CLASS}`}
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left"
              onClick={() => {
                const ref = discussionRef(item);
                if (onOpenReference) onOpenReference(ref);
                else onOpenFullPage?.(`/discussions/${item.id}`);
              }}
            >
              <span className="truncate font-medium">
                {discussionTitle(item)}
              </span>
              {item.reason === "extraction_failed" && (
                <span className="ml-1 shrink-0 rounded bg-destructive/10 px-1 text-[10px] text-destructive">
                  Failed
                </span>
              )}
              {item.pendingItemCount > 0 && (
                <span className="ml-1 shrink-0 rounded bg-brand/10 px-1 text-[10px] text-brand">
                  {item.pendingItemCount} pending
                </span>
              )}
            </button>
            {onAsk && (
              <button
                type="button"
                aria-label="Ask Commander about this"
                className="ml-1 hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex group-focus-within:flex"
                onClick={() => {
                  const prompt = discussionPrompt(item);
                  const ref = discussionRef(item);
                  if (onReference) onReference(ref, prompt);
                  else onAsk(prompt);
                }}
              >
                <MessageSquareIcon className="size-3" aria-hidden />
              </button>
            )}
            <button
              type="button"
              aria-label={`Open ${discussionTitle(item)} full page`}
              title="Open full page"
              className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex group-focus-within:flex"
              onClick={() => onOpenFullPage?.(`/discussions/${item.id}`)}
            >
              <ExternalLink className="size-3" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
