import { ExternalLink, MessageSquare } from "lucide-react";
import {
  type CockpitInboxItem,
  type CommanderInputRef,
} from "@armyofagents/shared";
import { setCommanderRefDragData } from "./cockpitReferenceDrag";
import { COCKPIT_DRAGGABLE_ROW_CLASS } from "./cockpitRowStyles";

const LANE_LABELS: Record<NonNullable<CockpitInboxItem["lane"]>, string> = {
  waiting_on_you: "Needs you",
  notifications: "Update",
  suggestions: "Suggestion",
};

const PRIORITY_CLASSES: Record<CockpitInboxItem["priority"], string> = {
  urgent: "bg-destructive/10 text-destructive",
  high: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  normal: "bg-muted text-muted-foreground",
  low: "bg-muted text-muted-foreground",
};

function laneSlug(item: CockpitInboxItem) {
  if (item.lane === "waiting_on_you") return "waiting";
  if (item.lane === "notifications") return "notifications";
  if (item.lane === "suggestions") return "suggestions";
  return "all";
}

function inboxItemPrompt(item: CockpitInboxItem) {
  return `Use this inbox item as context: ${item.title}${item.summary ? ` - ${item.summary}` : ""}`;
}

function inboxItemRef(item: CockpitInboxItem, href: string): CommanderInputRef {
  return {
    v: 1,
    kind: "inbox",
    id: item.id,
    label: item.title,
    route: href,
    detail: item.summary,
    source: item.sourceType ?? undefined,
  };
}

export function CockpitInboxCard({
  items,
  onOpenFullPage,
  onOpenReference,
  onOpenTask,
  onAsk,
  onReference,
}: {
  items: CockpitInboxItem[];
  onOpenFullPage?: (href: string) => void;
  onOpenReference?: (ref: CommanderInputRef) => void;
  onOpenTask?: (issueId: string, title: string, anchorId?: string) => void;
  onAsk?: (text: string) => void;
  onReference?: (ref: CommanderInputRef, suggestedPrompt?: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div data-testid="cockpit-card-inbox">
      <ul className="space-y-0.5">
        {items.map((item) => {
          const laneLabel = item.lane ? LANE_LABELS[item.lane] : "Inbox";
          const href = `/inbox/${laneSlug(item)}/${item.id}`;
          return (
            <li
              key={item.id}
              draggable
              onDragStart={(event) => {
                const prompt = inboxItemPrompt(item);
                const ref = inboxItemRef(item, href);
                setCommanderRefDragData(event.dataTransfer, ref, prompt);
              }}
              className={`group flex flex-col gap-1 rounded px-1 py-1.5 text-xs ${COCKPIT_DRAGGABLE_ROW_CLASS}`}
            >
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() => {
                    if (
                      item.sourceType === "work_question"
                      && item.sourceId
                      && item.relatedEntityType === "issue"
                      && item.relatedEntityId
                    ) {
                      onOpenTask?.(item.relatedEntityId, item.title, item.sourceId);
                      return;
                    }
                    const ref = inboxItemRef(item, href);
                    if (onOpenReference) onOpenReference(ref);
                    else onOpenFullPage?.(href);
                  }}
                >
                  <span className="truncate font-medium">
                    {item.unread && (
                      <span className="mr-1 inline-block size-1.5 rounded-full bg-brand align-middle" />
                    )}
                    {item.title}
                  </span>
                </button>
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  {laneLabel}
                </span>
                {item.priority === "urgent" || item.priority === "high" ? (
                  <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] ${PRIORITY_CLASSES[item.priority]}`}>
                    {item.priority}
                  </span>
                ) : null}
              </div>
              {item.summary && (
                <p className="line-clamp-2 px-0 text-[10px] leading-4 text-muted-foreground">
                  {item.summary}
                </p>
              )}
              <div className="flex items-center justify-end gap-1">
                {onAsk && (
                  <button
                    type="button"
                    aria-label="Ask Commander about this inbox item"
                    title="Ask Commander"
                    className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex group-focus-within:flex"
                    onClick={() => {
                      const prompt = inboxItemPrompt(item);
                      const ref = inboxItemRef(item, href);
                      if (onReference) onReference(ref, prompt);
                      else onAsk(prompt);
                    }}
                  >
                    <MessageSquare className="size-3" aria-hidden />
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Open inbox item"
                  title="Open inbox item"
                  className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex group-focus-within:flex"
                  onClick={() => onOpenFullPage?.(href)}
                >
                  <ExternalLink className="size-3" aria-hidden />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
