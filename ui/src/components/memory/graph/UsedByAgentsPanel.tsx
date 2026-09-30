import { Bot, Loader2 } from "lucide-react";
import type { CompanyBrainMemoryUsageAgent } from "@armyofagents/shared";

interface UsedByAgentsPanelProps {
  usage: CompanyBrainMemoryUsageAgent[];
  isLoading: boolean;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatLastRetrieved(value: string | null): string {
  if (!value) return "No retrieval date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `Last retrieved ${date.toLocaleString()}`;
}

export function UsedByAgentsPanel({ usage, isLoading }: UsedByAgentsPanelProps) {
  return (
    <section className="rounded-md border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <Bot className="h-3.5 w-3.5 text-muted-foreground" />
          Used by agents
        </div>
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      <div className="grid gap-2 p-3">
        {!isLoading && usage.length === 0 && (
          <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            No agent retrievals yet
          </div>
        )}
        {usage.map((agent) => (
          <div
            key={agent.agentId ?? agent.agentName}
            className="rounded-md border border-border bg-background px-3 py-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">{agent.agentName}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {formatLastRetrieved(agent.lastRetrievedAt)}
                </div>
              </div>
              <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                <div>{plural(agent.retrievalCount, "retrieval")}</div>
                <div>{plural(agent.linkedTaskCount, "linked task")}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
