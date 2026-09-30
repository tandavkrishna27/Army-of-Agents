import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3 } from "lucide-react";
import type { InstanceSchedulerHeartbeatAgent } from "@armyofagents/shared";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

interface HeartbeatsTabViewProps {
  agents: InstanceSchedulerHeartbeatAgent[];
  actionError: string | null;
  isTogglingId: string | null;
  isDisablingAll: boolean;
  onToggle: (agent: InstanceSchedulerHeartbeatAgent) => void;
  onDisableAll: (agents: InstanceSchedulerHeartbeatAgent[]) => void;
}

export function HeartbeatsTabView({
  agents,
  actionError,
  isTogglingId,
  isDisablingAll,
  onToggle,
  onDisableAll,
}: HeartbeatsTabViewProps) {
  const [companyFilter, setCompanyFilter] = useState<string>("__all__");
  const companyOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) {
      if (!map.has(a.companyId)) map.set(a.companyId, a.companyName);
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents]);
  const filteredAgents = useMemo(() => {
    if (companyFilter === "__all__") return agents;
    return agents.filter((a) => a.companyId === companyFilter);
  }, [agents, companyFilter]);
  const activeCount = filteredAgents.filter((a) => a.schedulerActive).length;
  const disabledCount = filteredAgents.length - activeCount;
  const enabledCount = filteredAgents.filter((a) => a.heartbeatEnabled).length;
  const anyEnabled = enabledCount > 0;
  const [disableAllConfirmOpen, setDisableAllConfirmOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Heartbeats</h2>
        <p className="text-sm text-muted-foreground">
          Agents with a timer heartbeat. Toggle per agent or disable all at once.
        </p>
      </div>

      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span>
          <span data-testid="active-count" className="font-semibold text-foreground">
            {activeCount}
          </span>{" "}
          active
        </span>
        <span>
          <span data-testid="disabled-count" className="font-semibold text-foreground">
            {disabledCount}
          </span>{" "}
          disabled
        </span>
        {companyOptions.length > 1 && (
          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="heartbeats-company-filter" className="text-xs shrink-0">
              Company
            </label>
            <Select value={companyFilter} onValueChange={setCompanyFilter}>
              <SelectTrigger
                id="heartbeats-company-filter"
                className="h-7 w-40 text-xs"
                aria-label="Filter heartbeats by company"
              >
                <SelectValue placeholder="All companies" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All companies</SelectItem>
                {companyOptions.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {anyEnabled && (
          <Button
            variant="destructive"
            size="sm"
            className={companyOptions.length > 1 ? "h-7 text-xs" : "ml-auto h-7 text-xs"}
            disabled={isDisablingAll}
            onClick={() => setDisableAllConfirmOpen(true)}
          >
            {isDisablingAll ? "Disabling..." : "Disable All"}
          </Button>
        )}
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {filteredAgents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Clock3 className="h-6 w-6 opacity-60" />
            <span>No scheduler heartbeats match the current criteria.</span>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {filteredAgents.map((agent) => {
                const saving = isTogglingId === agent.id;
                return (
                  <div
                    key={agent.id}
                    className="flex items-center gap-3 px-3 py-2 text-sm"
                  >
                    <Badge
                      variant={agent.schedulerActive ? "default" : "outline"}
                      className="shrink-0 text-[10px] px-1.5 py-0"
                    >
                      {agent.schedulerActive ? "On" : "Off"}
                    </Badge>
                    <span className="font-medium truncate">{agent.agentName}</span>
                    <Badge
                      variant="outline"
                      className="shrink-0 text-[10px] px-1.5 py-0 font-normal text-muted-foreground"
                      title={agent.companyName}
                    >
                      {agent.companyIssuePrefix ?? agent.companyName}
                    </Badge>
                    <span className="hidden sm:inline text-muted-foreground truncate">
                      {humanize(agent.title ?? agent.role)}
                    </span>
                    <span className="text-muted-foreground tabular-nums shrink-0">
                      {agent.intervalSec}s
                    </span>
                    <span className="hidden md:inline text-muted-foreground truncate">
                      {agent.lastHeartbeatAt ? timeAgo(agent.lastHeartbeatAt) : "never"}
                    </span>
                    <span className="ml-auto flex items-center gap-1.5 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        disabled={saving}
                        onClick={() => onToggle(agent)}
                      >
                        {saving
                          ? "..."
                          : agent.heartbeatEnabled
                            ? "Disable Timer Heartbeat"
                            : "Enable Timer Heartbeat"}
                      </Button>
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={disableAllConfirmOpen}
        onOpenChange={setDisableAllConfirmOpen}
        title={`Disable timer heartbeats for all ${enabledCount} enabled ${enabledCount === 1 ? "agent" : "agents"}?`}
        confirmLabel="Disable all"
        onConfirm={() => {
          onDisableAll(filteredAgents);
          setDisableAllConfirmOpen(false);
        }}
      />
    </div>
  );
}

export function HeartbeatsTab() {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const heartbeatsQuery = useQuery({
    queryKey: queryKeys.instanceSettings.schedulerHeartbeats,
    queryFn: () => heartbeatsApi.listInstanceSchedulerAgents(),
    refetchInterval: 15_000,
  });

  const toggleMutation = useMutation({
    mutationFn: async (agentRow: InstanceSchedulerHeartbeatAgent) => {
      const agent = await agentsApi.get(agentRow.id, agentRow.companyId);
      const runtimeConfig = asRecord((agent as { runtimeConfig?: unknown }).runtimeConfig) ?? {};
      const heartbeat = asRecord(runtimeConfig.heartbeat) ?? {};

      return agentsApi.update(
        agentRow.id,
        {
          runtimeConfig: {
            ...runtimeConfig,
            heartbeat: { ...heartbeat, enabled: !agentRow.heartbeatEnabled },
          },
        },
        agentRow.companyId,
      );
    },
    onSuccess: async (_, agentRow) => {
      setActionError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instanceSettings.schedulerHeartbeats }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agentRow.companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentRow.id) }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update heartbeat.");
    },
  });

  const disableAllMutation = useMutation({
    mutationFn: async (agentRows: InstanceSchedulerHeartbeatAgent[]) => {
      const enabled = agentRows.filter((a) => a.heartbeatEnabled);
      if (enabled.length === 0) return enabled;

      const results = await Promise.allSettled(
        enabled.map(async (agentRow) => {
          const agent = await agentsApi.get(agentRow.id, agentRow.companyId);
          const runtimeConfig = asRecord((agent as { runtimeConfig?: unknown }).runtimeConfig) ?? {};
          const heartbeat = asRecord(runtimeConfig.heartbeat) ?? {};
          await agentsApi.update(
            agentRow.id,
            {
              runtimeConfig: {
                ...runtimeConfig,
                heartbeat: { ...heartbeat, enabled: false },
              },
            },
            agentRow.companyId,
          );
        }),
      );

      const failures = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (failures.length > 0) {
        const firstError = failures[0]?.reason;
        const detail = firstError instanceof Error ? firstError.message : "Unknown error";
        throw new Error(
          failures.length === 1
            ? `Failed to disable 1 timer heartbeat: ${detail}`
            : `Failed to disable ${failures.length} of ${enabled.length} timer heartbeats. First error: ${detail}`,
        );
      }
      return enabled;
    },
    onSuccess: async (updatedRows) => {
      setActionError(null);
      const companies = new Set(updatedRows.map((row) => row.companyId));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instanceSettings.schedulerHeartbeats }),
        ...Array.from(companies, (companyId) =>
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
        ),
        ...updatedRows.map((row) =>
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(row.id) }),
        ),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to disable all heartbeats.");
    },
  });

  if (heartbeatsQuery.isLoading) {
    return (
      <div className="text-sm text-muted-foreground">Loading scheduler heartbeats...</div>
    );
  }

  if (heartbeatsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {heartbeatsQuery.error instanceof Error
          ? heartbeatsQuery.error.message
          : "Failed to load scheduler heartbeats."}
      </div>
    );
  }

  const agents = heartbeatsQuery.data ?? [];

  return (
    <HeartbeatsTabView
      agents={agents}
      actionError={actionError}
      isTogglingId={toggleMutation.isPending ? (toggleMutation.variables?.id ?? null) : null}
      isDisablingAll={disableAllMutation.isPending}
      onToggle={(agent) => toggleMutation.mutate(agent)}
      onDisableAll={(rows) => disableAllMutation.mutate(rows)}
    />
  );
}
