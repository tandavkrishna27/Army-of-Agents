import { MessageSquare } from "lucide-react";
import type { CockpitRunItem, CommanderInputRef } from "@armyofagents/shared";
import { setCommanderRefDragData } from "./cockpitReferenceDrag";
import { COCKPIT_DRAGGABLE_ROW_CLASS } from "./cockpitRowStyles";

function runPrompt(run: CockpitRunItem) {
  return `What is ${run.agentName ?? "the agent"} working on right now? Is there anything I should know?`;
}

function runRef(run: CockpitRunItem): CommanderInputRef | null {
  if (!run.issueId) return null;
  return {
    v: 1,
    kind: "task",
    id: run.issueId,
    label: run.agentName ? `Run by ${run.agentName}` : "Running task",
    route: `/issues/${run.issueId}`,
    detail: `run=${run.id}; status=${run.status}`,
  };
}

// Phase 5B: Internal <header> removed — title/icon/count now live in the
// CockpitSection trigger in CommanderCockpitPanel. Card renders only body rows.

export function CockpitRunningCard({
  runs,
  onOpenTask,
  onAsk,
  onReference,
}: {
  runs: CockpitRunItem[];
  onOpenTask?: (issueId: string, title: string) => void;
  onAsk?: (text: string) => void;
  onReference?: (ref: CommanderInputRef, suggestedPrompt?: string) => void;
}) {
  if (runs.length === 0) return null;

  return (
    <div data-testid="cockpit-card-running">
      <ul className="space-y-0.5">
        {runs.map((r) => (
          <li
            key={r.id}
            draggable={Boolean(r.issueId)}
            onDragStart={(event) => {
              const ref = runRef(r);
              if (ref) setCommanderRefDragData(event.dataTransfer, ref, runPrompt(r));
            }}
            className={`group flex items-center gap-1 truncate rounded px-1 py-1 text-xs ${
              r.issueId ? COCKPIT_DRAGGABLE_ROW_CLASS : "hover:bg-muted/50"
            }`}
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left"
              onClick={() => {
                if (r.issueId && onOpenTask) {
                  onOpenTask(r.issueId, r.agentName ? `Run by ${r.agentName}` : "Running task");
                }
              }}
            >
              <span className="truncate font-medium">{r.agentName ?? "Agent"}</span>
            </button>
            <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
              {r.status}
            </span>
            {onAsk && (
              <button
                type="button"
                aria-label="Ask Commander about this"
                className="ml-1 hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                onClick={() => {
                  const prompt = runPrompt(r);
                  const ref = runRef(r);
                  if (onReference && ref) {
                    onReference(ref, prompt);
                    return;
                  }
                  onAsk(prompt);
                }}
              >
                <MessageSquare className="size-3" aria-hidden />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
