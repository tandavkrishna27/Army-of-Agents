import type { Agent } from "@armyofagents/shared";
import type { LiveRunForIssue } from "../../api/heartbeats";
import { cn } from "../../lib/utils";
import { AgentIcon } from "../AgentIconPicker";
import { formatDistanceToNowStrict } from "date-fns";

interface CommanderKanbanTabProps {
  agents: Agent[];
  liveRuns: LiveRunForIssue[];
}

type KanbanColumn = {
  id: string;
  label: string;
  dotClass: string;
  emptyText: string;
};

const COLUMNS: KanbanColumn[] = [
  { id: "idle",     label: "Idle",             dotClass: "bg-yellow-400",               emptyText: "No idle agents" },
  { id: "running",  label: "Running",           dotClass: "bg-cyan-400 animate-pulse",   emptyText: "Nothing running" },
  { id: "approval", label: "Awaiting Approval", dotClass: "bg-amber-400",               emptyText: "No pending approvals" },
  { id: "error",    label: "Error",             dotClass: "bg-red-400",                 emptyText: "No errors" },
  { id: "paused",   label: "Paused",            dotClass: "bg-yellow-400",              emptyText: "No agents paused" },
];

export function agentStatusToColumn(status: string): string {
  switch (status) {
    case "running":          return "running";
    case "pending_approval": return "approval";
    case "error":            return "error";
    case "paused":           return "paused";
    default:                 return "idle"; // active, idle, archived
  }
}

function relativeTime(date: string | Date | null | undefined): string {
  if (!date) return "";
  try {
    return formatDistanceToNowStrict(new Date(date), { addSuffix: true });
  } catch {
    return "";
  }
}

export function CommanderKanbanTab({ agents, liveRuns }: CommanderKanbanTabProps) {
  // Build agentId → live run lookup
  const runByAgent = new Map<string, LiveRunForIssue>(
    liveRuns.map((r) => [r.agentId, r]),
  );

  // Group agents by column
  const byColumn = new Map<string, Agent[]>(COLUMNS.map((c) => [c.id, []]));
  for (const agent of agents) {
    const col = agentStatusToColumn(agent.status);
    byColumn.get(col)!.push(agent);
  }

  return (
    <div className="overflow-x-auto pb-4">
      <div className="flex gap-3.5 items-start min-w-max">
        {COLUMNS.map((col) => {
          const colAgents = byColumn.get(col.id) ?? [];
          return (
            <div key={col.id} className="w-[250px] shrink-0 flex flex-col gap-2.5">
              {/* Column header */}
              <div
                className="flex items-center gap-1.5 px-0.5 pb-2 border-b border-border/50"
                data-testid={`kanban-column-${col.id}`}
              >
                <div className={cn("w-2 h-2 rounded-full shrink-0", col.dotClass)} />
                <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                  {col.label}
                </span>
                <span className="ml-auto bg-card text-muted-foreground/60 text-[10px] font-bold px-1.5 py-0.5 rounded-lg">
                  {colAgents.length}
                </span>
              </div>

              {/* Cards */}
              {colAgents.length === 0 ? (
                <div className="border border-dashed border-border rounded-lg p-5 text-center text-[11px] text-muted-foreground/40">
                  {col.emptyText}
                </div>
              ) : (
                colAgents.map((agent) => {
                  const run = runByAgent.get(agent.id);
                  const isLive = col.id === "running";
                  const isApproval = col.id === "approval";
                  const isError = col.id === "error";

                  return (
                    <div
                      key={agent.id}
                      className={cn(
                        "border border-border bg-card rounded-lg p-3 cursor-pointer",
                        "transition-colors duration-150 hover:bg-card/80",
                        isLive && "border-cyan-500/30 bg-cyan-950/5",
                        isApproval && "border-amber-500/30",
                        isError && "border-red-500/30",
                      )}
                    >
                      {/* Task title — primary content */}
                      <p className="text-[13px] font-semibold leading-snug mb-1 line-clamp-3">
                        {run?.issueId
                          ? `Task #${run.issueId.slice(-6)}`
                          : col.id === "idle"
                          ? agent.lastHeartbeatAt
                            ? "Last task completed"
                            : "Waiting for first task"
                          : "Working…"}
                      </p>

                      {/* Status/timing line */}
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-2.5">
                        {isLive && (
                          <span className="relative flex h-2 w-2 shrink-0">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
                          </span>
                        )}
                        <span className={isLive ? "text-cyan-400 font-medium" : ""}>
                          {isLive && run?.startedAt
                            ? `Running · ${relativeTime(run.startedAt)}`
                            : isApproval
                            ? `Waiting · ${relativeTime(run?.createdAt)}`
                            : isError && run?.finishedAt
                            ? `Failed ${relativeTime(run.finishedAt)}`
                            : col.id === "idle" && agent.lastHeartbeatAt
                            ? `Completed ${relativeTime(agent.lastHeartbeatAt)}`
                            : col.id === "paused"
                            ? "Paused"
                            : "—"}
                        </span>
                      </div>

                      {/* Callout strip for notable states */}
                      {isApproval && (
                        <div className="mb-2.5 rounded-md px-2.5 py-1.5 text-[11px] bg-amber-950/30 border border-amber-500/20 text-amber-300">
                          🔔 Decision needed before continuing
                        </div>
                      )}
                      {isError && (
                        <div className="mb-2.5 rounded-md px-2.5 py-1.5 text-[11px] bg-red-950/20 border border-red-500/20 text-red-300">
                          ⚠ Exit error — check agent logs
                        </div>
                      )}
                      {col.id === "idle" && !agent.lastHeartbeatAt && (
                        <div className="mb-2.5 rounded-md px-2.5 py-1.5 text-[11px] bg-white/[0.03] border border-border/50 text-muted-foreground">
                          Waiting for next task
                        </div>
                      )}

                      {/* Agent attribution footer */}
                      <div className="flex items-center gap-1.5 pt-2 border-t border-border/50">
                        <div className="h-5 w-5 rounded-[5px] bg-accent flex items-center justify-center shrink-0">
                          <AgentIcon icon={agent.icon} className="h-3 w-3" />
                        </div>
                        <span className="text-[11px] font-medium text-muted-foreground truncate flex-1 min-w-0">
                          {agent.name}
                        </span>
                        <span className="text-[10px] text-muted-foreground/50 font-mono shrink-0">
                          {agent.adapterType}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
