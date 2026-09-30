import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, RotateCcw } from "lucide-react";
import type { Agent, ActivityEvent } from "@armyofagents/shared";
import { useCompany } from "@/context/CompanyContext";
import { activityApi } from "@/api/activity";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { goalsApi } from "@/api/goals";
import { queryKeys } from "@/lib/queryKeys";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { ActivityRow } from "@/components/ActivityRow";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";

const ENTITY_TYPES = [
  { key: "issue",         label: "Tasks",      color: "#3b82f6" },
  { key: "agent",         label: "Agents",     color: "#8b5cf6" },
  { key: "heartbeat_run", label: "Heartbeats", color: "#14b8a6" },
  { key: "approval",      label: "Approvals",  color: "#22c55e" },
  { key: "goal",          label: "Goals",      color: "#f59e0b" },
] as const;

const TIME_RANGES = [
  { key: "live",  label: "Live (30m)" },
  { key: "today", label: "Today" },
  { key: "7d",    label: "Last 7 days" },
  { key: "30d",   label: "Last 30 days" },
  { key: "all",   label: "All time" },
] as const;

const ACTOR_TYPES = [
  { key: "agent",  label: "Agents" },
  { key: "user",   label: "Board" },
  { key: "system", label: "System" },
] as const;

function entityBorderColor(entityType: string): string {
  switch (entityType) {
    case "issue":         return "#3b82f6";
    case "agent":         return "#8b5cf6";
    case "heartbeat_run": return "#14b8a6";
    case "approval":      return "#22c55e";
    case "goal":          return "#f59e0b";
    default:              return "transparent";
  }
}

function filterByTimeRange(events: ActivityEvent[], range: string): ActivityEvent[] {
  const now = Date.now();
  switch (range) {
    case "live": return events.filter(e => now - +new Date(e.createdAt) < 30 * 60 * 1000);
    case "today": {
      const sod = new Date(); sod.setHours(0, 0, 0, 0);
      return events.filter(e => new Date(e.createdAt) >= sod);
    }
    case "7d":  return events.filter(e => now - +new Date(e.createdAt) < 7 * 86400_000);
    case "30d": return events.filter(e => now - +new Date(e.createdAt) < 30 * 86400_000);
    default: return events;
  }
}

function groupByDay(events: ActivityEvent[]): { label: string; events: ActivityEvent[] }[] {
  const now = new Date();
  const today     = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400_000;

  const order: string[] = [];
  const map = new Map<string, ActivityEvent[]>();

  for (const event of events) {
    const d = new Date(event.createdAt);
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const label =
      day === today     ? "Today" :
      day === yesterday ? "Yesterday" :
      d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    if (!map.has(label)) { map.set(label, []); order.push(label); }
    map.get(label)!.push(event);
  }

  return order.map(label => ({ label, events: map.get(label)! }));
}

export function ActivitySection() {
  const { selectedCompanyId } = useCompany();
  const [selectedTypes,  setSelectedTypes]  = useState<Set<string>>(new Set());
  const [timeRange,      setTimeRange]      = useState("all");
  const [selectedActors, setSelectedActors] = useState<Set<string>>(new Set());

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn:  () => activityApi.list(selectedCompanyId!),
    enabled:  !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn:  () => agentsApi.list(selectedCompanyId!),
    enabled:  !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn:  () => issuesApi.list(selectedCompanyId!),
    enabled:  !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn:  () => projectsApi.list(selectedCompanyId!),
    enabled:  !!selectedCompanyId,
  });

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn:  () => goalsApi.list(selectedCompanyId!),
    enabled:  !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues   ?? []) map.set(`issue:${i.id}`,   i.identifier ?? i.id.slice(0, 8));
    for (const a of agents   ?? []) map.set(`agent:${a.id}`,   a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    for (const g of goals    ?? []) map.set(`goal:${g.id}`,    g.title);
    return map;
  }, [issues, agents, projects, goals]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of data ?? []) counts.set(e.entityType, (counts.get(e.entityType) ?? 0) + 1);
    return counts;
  }, [data]);

  const activeAgentCount = useMemo(
    () => (agents ?? []).filter(a => a.status === "active" || a.status === "running").length,
    [agents],
  );

  const heartbeatsTodayCount = useMemo(() => {
    const sod = new Date(); sod.setHours(0, 0, 0, 0);
    return (data ?? []).filter(e => e.entityType === "heartbeat_run" && new Date(e.createdAt) >= sod).length;
  }, [data]);

  const filtered = useMemo(() => {
    let events = data ?? [];
    if (timeRange !== "all")     events = filterByTimeRange(events, timeRange);
    if (selectedTypes.size > 0)  events = events.filter(e => selectedTypes.has(e.entityType));
    if (selectedActors.size > 0) events = events.filter(e => selectedActors.has(e.actorType));
    return events;
  }, [data, timeRange, selectedTypes, selectedActors]);

  const grouped = useMemo(() => groupByDay(filtered), [filtered]);

  const lastEvent = data?.[0];
  const hasActiveFilters = selectedTypes.size > 0 || timeRange !== "all" || selectedActors.size > 0;

  function toggleType(key: string) {
    setSelectedTypes(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function toggleActor(key: string) {
    setSelectedActors(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function resetFilters() {
    setSelectedTypes(new Set());
    setTimeRange("all");
    setSelectedActors(new Set());
  }

  return (
    <div>
      {/* ── Section header — matches GeneralSection pattern ─── */}
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Company
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          Activity<span className="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          All company activity — heartbeats, task changes, agent runs, and discussion entries.
        </p>
      </div>

      {/* ── Content body ──────────────────────────────────────── */}
      {!selectedCompanyId ? (
        <div className="p-8">
          <EmptyState icon={History} message="Select a company to view activity." />
        </div>
      ) : isLoading ? (
        <div className="p-8"><PageSkeleton variant="list" /></div>
      ) : (
        <div className="px-8 pt-6 pb-8 flex flex-col gap-4">
          {/* Meta bar — full width */}
          <div className="flex items-center gap-3.5 px-3.5 py-2.5 rounded-lg border border-border bg-card text-sm">
            <MetaStat value={data?.length ?? 0} label="events" />
            <MetaDivider />
            <MetaStat value={activeAgentCount} label="agents active" />
            <MetaDivider />
            <MetaStat value={heartbeatsTodayCount} label="heartbeats today" />
            {lastEvent && (
              <>
                <MetaDivider />
                <span className="text-xs text-muted-foreground">
                  last {timeAgo(lastEvent.createdAt)}
                </span>
              </>
            )}
            <div className="ml-auto flex items-center gap-1.5 text-xs text-green-500 bg-green-500/[0.08] border border-green-500/[0.18] rounded px-1.5 py-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              Live
            </div>
          </div>

          {/* Count row — full width */}
          <div className="flex items-center">
            <span className="text-xs text-muted-foreground">
              {filtered.length} event{filtered.length !== 1 ? "s" : ""}
              {hasActiveFilters && " (filtered)"}
            </span>
          </div>

          {/* ── Flex row: event list + right rail ─────────────── */}
          <div className="flex gap-6 min-h-0">
            {/* Event list */}
            <div className="flex-1 min-w-0">
              {error && (
                <p className="text-sm text-destructive mb-3">{error.message}</p>
              )}
              {filtered.length === 0 && !error && (
                <EmptyState icon={History} message="No activity matches the current filters." />
              )}
              {grouped.length > 0 && (
                <div className="rounded-lg border border-border overflow-hidden">
                  {grouped.map(({ label, events }, gi) => (
                    <div key={label}>
                      {/* Day separator */}
                      <div className={cn(
                        "flex items-center gap-2 px-3.5 py-1.5 bg-muted/30",
                        gi > 0 && "border-t border-border",
                      )}>
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                          {label}
                        </span>
                        <span className="text-[10px] text-muted-foreground/40 bg-muted/50 border border-border px-1.5 py-px rounded-full">
                          {events.length}
                        </span>
                      </div>
                      {/* Event rows */}
                      {events.map((event, i) => (
                        <div
                          key={event.id}
                          className={cn("border-l-2", i < events.length - 1 && "border-b border-border")}
                          style={{ borderLeftColor: entityBorderColor(event.entityType) }}
                        >
                          <ActivityRow
                            event={event}
                            agentMap={agentMap}
                            entityNameMap={entityNameMap}
                            entityTitleMap={entityTitleMap}
                          />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Right filter rail */}
            <div className="w-40 flex-shrink-0 flex flex-col gap-5">
              {/* Entity types */}
              <FilterSection title="Type">
                {ENTITY_TYPES.map(({ key, label, color }) => {
                  const count = typeCounts.get(key) ?? 0;
                  if (count === 0) return null;
                  return (
                    <label key={key} className="flex items-center gap-2 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={selectedTypes.has(key)}
                        onChange={() => toggleType(key)}
                        className="sr-only"
                      />
                      <span
                        className="flex-shrink-0 w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors"
                        style={selectedTypes.has(key)
                          ? { background: color, borderColor: color }
                          : { borderColor: "hsl(var(--border))" }}
                      >
                        {selectedTypes.has(key) && (
                          <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                            <path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      <span className="flex items-center gap-1.5 flex-1 min-w-0">
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
                        <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors truncate">
                          {label}
                        </span>
                      </span>
                      <span className="text-[10px] text-muted-foreground/40 flex-shrink-0">{count}</span>
                    </label>
                  );
                })}
              </FilterSection>

              {/* Time range */}
              <FilterSection title="Time range">
                {TIME_RANGES.map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer group" onClick={() => setTimeRange(key)}>
                    <span className={cn(
                      "flex-shrink-0 w-3.5 h-3.5 rounded-full border flex items-center justify-center transition-colors",
                      timeRange === key ? "border-brand bg-brand/10" : "border-border",
                    )}>
                      {timeRange === key && <span className="w-1.5 h-1.5 rounded-full bg-brand" />}
                    </span>
                    <span className={cn(
                      "text-xs transition-colors",
                      timeRange === key ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
                    )}>
                      {label}
                    </span>
                  </label>
                ))}
              </FilterSection>

              {/* Actor */}
              <FilterSection title="Actor">
                {ACTOR_TYPES.map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={selectedActors.has(key)}
                      onChange={() => toggleActor(key)}
                      className="sr-only"
                    />
                    <span className={cn(
                      "flex-shrink-0 w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors",
                      selectedActors.has(key) ? "bg-foreground/80 border-foreground/80" : "border-border",
                    )}>
                      {selectedActors.has(key) && (
                        <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                          <path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">
                      {label}
                    </span>
                  </label>
                ))}
              </FilterSection>

              {/* Reset */}
              {hasActiveFilters && (
                <button
                  onClick={resetFilters}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset filters
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetaStat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-[15px] font-bold tracking-tight tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function MetaDivider() {
  return <span className="w-px h-3.5 bg-border flex-shrink-0" />;
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
        {title}
      </span>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}
