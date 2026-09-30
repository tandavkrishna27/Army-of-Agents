import { MessageSquare, Pin } from "lucide-react";
import type { CockpitPinnedEntityType, CockpitReminderItem, CockpitTaskItem, CommanderInputRef } from "@armyofagents/shared";
import { setCommanderRefDragData } from "./cockpitReferenceDrag";
import { COCKPIT_DRAGGABLE_ROW_CLASS } from "./cockpitRowStyles";

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

function dueTaskPrompt(item: CockpitTaskItem) {
  return `${item.identifier ?? item.title} is due today - what's the current status and is there anything blocking it?`;
}

export function CockpitTodayCard({
  reminders,
  dueTasks,
  onOpenTask,
  onAsk,
  onReference,
  onPin,
}: {
  reminders: CockpitReminderItem[];
  dueTasks: CockpitTaskItem[];
  onOpenTask?: (issueId: string, title: string) => void;
  onAsk?: (text: string) => void;
  onReference?: (ref: CommanderInputRef, suggestedPrompt?: string) => void;
  onPin?: (entityType: CockpitPinnedEntityType, entityId: string) => void;
}) {
  const totalCount = reminders.length + dueTasks.length;
  if (totalCount === 0) return null;

  // Phase 5B: Internal <header> removed — title/icon/count now live in the
  // CockpitSection trigger in CommanderCockpitPanel. Card renders only body rows.
  return (
    <div data-testid="cockpit-card-today">
      {reminders.length > 0 && (
        <>
          <p className="mt-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Reminders
          </p>
          <ul className="space-y-0.5">
            {reminders.map((r) => (
              <li
                key={r.id}
                className="group flex items-center gap-1 truncate rounded px-1 py-1 text-xs hover:bg-muted/50"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{r.content}</span>
                {onAsk && (
                  <button
                    type="button"
                    aria-label="Ask Commander about this"
                    className="ml-1 hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                    onClick={() => onAsk(`Tell me more about this reminder: ${r.content}`)}
                  >
                    <MessageSquare className="size-3" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {dueTasks.length > 0 && (
        <>
          <p className="mt-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Due today
          </p>
          <ul className="space-y-0.5">
            {dueTasks.map((item) => (
              <li
                key={item.id}
                draggable
                onDragStart={(event) => setCommanderRefDragData(event.dataTransfer, taskRef(item), dueTaskPrompt(item))}
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
                </button>
                {onAsk && (
                  <button
                    type="button"
                    aria-label="Ask Commander about this"
                    className="ml-1 hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                    onClick={() => {
                      const prompt = dueTaskPrompt(item);
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
        </>
      )}
    </div>
  );
}
