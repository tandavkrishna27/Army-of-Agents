import { useState } from "react";
import type { Agent, AgentTrustScore } from "@armyofagents/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../../context/CompanyContext";
import { useToast } from "../../context/ToastContext";
import { agentsApi } from "../../api/agents";
import { approvalsApi } from "../../api/approvals";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { AgentIcon } from "../AgentIconPicker";
import { StatusBadge } from "../StatusBadge";
import {
  getTrustScoreTone,
  getTrustScoreToneClasses,
  formatTrustScorePercent,
  hasTrustScoreData,
} from "../../lib/trust-score";
import { agentStatusDot, agentStatusDotDefault } from "../../lib/status-colors";
import { formatDistanceToNowStrict } from "date-fns";

interface CommanderGovernanceTabProps {
  agents: Agent[];
  trustScores: AgentTrustScore[];
  isFounder: boolean;
  onMutationSuccess?: () => void;
}

/** Inline-editable budget limit cell. Fires PATCH on blur if value changed. */
function BudgetEditCell({
  agent,
  isFounder,
  onSave,
}: {
  agent: Agent;
  isFounder: boolean;
  onSave: (cents: number) => void;
}) {
  const spent = (agent.spentMonthlyCents / 100).toFixed(0);
  const limitDollars = (agent.budgetMonthlyCents / 100).toFixed(0);
  const [value, setValue] = useState(limitDollars);
  const pct =
    agent.budgetMonthlyCents > 0
      ? Math.min(100, Math.round((agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100))
      : 0;
  const barColor =
    pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-yellow-500" : "bg-green-500";

  return (
    <div className="flex items-center gap-1.5 min-w-[130px]">
      <div className="w-11 h-1 rounded-full bg-accent overflow-hidden shrink-0">
        <div className={cn("h-full rounded-full", barColor)} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn("text-[11px] text-muted-foreground", pct >= 90 && "text-red-400")}>
        ${spent} /
      </span>
      {isFounder ? (
        <input
          className={cn(
            "text-[12px] w-16 rounded-md px-1.5 py-0.5",
            "border border-transparent bg-transparent",
            "hover:border-border hover:bg-card",
            "focus:outline-none focus:border-brand focus:bg-background",
            "transition-colors cursor-text",
            pct >= 90 && "text-red-400",
          )}
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
          onBlur={() => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num !== parseInt(limitDollars, 10)) {
              onSave(num * 100);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") { setValue(limitDollars); (e.target as HTMLInputElement).blur(); }
          }}
          title="Monthly budget limit ($)"
        />
      ) : (
        <span className="text-[12px] text-muted-foreground">${limitDollars}</span>
      )}
      <span className="text-[10px] text-muted-foreground/50">/mo</span>
    </div>
  );
}

/** canCreateAgents toggle — calls onToggle on click (founder only) */
function CanHireToggle({
  enabled,
  isFounder,
  onToggle,
}: {
  enabled: boolean;
  isFounder: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className={cn(
        "flex items-center gap-1.5 cursor-default",
        isFounder && "cursor-pointer",
      )}
      onClick={isFounder ? onToggle : undefined}
      title={isFounder ? "Toggle canCreateAgents" : undefined}
    >
      <div
        className={cn(
          "relative w-7 h-4 rounded-full border transition-colors",
          enabled
            ? "bg-green-500/20 border-green-500/40"
            : "bg-card border-border",
        )}
      >
        <div
          className={cn(
            "absolute top-0.5 h-2.5 w-2.5 rounded-full transition-transform",
            enabled ? "translate-x-3.5 bg-green-400" : "translate-x-0.5 bg-muted-foreground/40",
          )}
        />
      </div>
      <span className="text-[11px] text-muted-foreground">
        {enabled ? "On" : "Off"}
      </span>
    </button>
  );
}

function relativeTime(date: string | Date | null | undefined): string {
  if (!date) return "—";
  try {
    return formatDistanceToNowStrict(new Date(date), { addSuffix: true });
  } catch {
    return "—";
  }
}

export function CommanderGovernanceTab({
  agents,
  trustScores,
  isFounder,
  onMutationSuccess,
}: CommanderGovernanceTabProps) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const trustMap = new Map(trustScores.map((ts) => [ts.agentId, ts]));

  function invalidate() {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: ["aoa-agents", selectedCompanyId] });
    queryClient.invalidateQueries({ queryKey: queryKeys.trustScores.list(selectedCompanyId) });
    onMutationSuccess?.();
  }

  const pauseMut = useMutation({
    mutationFn: (id: string) => agentsApi.pause(id, selectedCompanyId ?? undefined),
    onSuccess: () => { invalidate(); pushToast({ title: "Agent paused", tone: "success" }); },
    onError: (e: Error) => pushToast({ title: "Failed to pause", body: e.message, tone: "error" }),
  });

  const resumeMut = useMutation({
    mutationFn: (id: string) => agentsApi.resume(id, selectedCompanyId ?? undefined),
    onSuccess: () => { invalidate(); pushToast({ title: "Agent resumed", tone: "success" }); },
    onError: (e: Error) => pushToast({ title: "Failed to resume", body: e.message, tone: "error" }),
  });

  const budgetMut = useMutation({
    mutationFn: ({ id, cents }: { id: string; cents: number }) =>
      agentsApi.update(id, { budgetMonthlyCents: cents }, selectedCompanyId ?? undefined),
    onSuccess: () => { invalidate(); pushToast({ title: "Budget updated", tone: "success" }); },
    onError: (e: Error) => pushToast({ title: "Failed to update budget", body: e.message, tone: "error" }),
  });

  const permMut = useMutation({
    mutationFn: ({ id, canCreateAgents }: { id: string; canCreateAgents: boolean }) =>
      agentsApi.updatePermissions(id, { canCreateAgents }, selectedCompanyId ?? undefined),
    onSuccess: () => { invalidate(); pushToast({ title: "Permission updated", tone: "success" }); },
    onError: (e: Error) => pushToast({ title: "Failed to update permission", body: e.message, tone: "error" }),
  });

  const approveMut = useMutation({
    mutationFn: (approvalId: string) => approvalsApi.approve(approvalId),
    onSuccess: () => { invalidate(); pushToast({ title: "Approved", tone: "success" }); },
    onError: (e: Error) => pushToast({ title: "Failed to approve", body: e.message, tone: "error" }),
  });

  // Summary metrics
  const avgTrust = trustScores.length > 0
    ? Math.round(trustScores.reduce((s, t) => s + t.currentScore, 0) / trustScores.length)
    : 0;
  const monthlySpend = agents.reduce((s, a) => s + a.spentMonthlyCents, 0);
  const errorCount = agents.filter((a) => a.status === "error").length;
  const pendingCount = agents.filter((a) => a.status === "pending_approval").length;

  return (
    <div className="space-y-5">
      {/* Summary metric cards */}
      <div className="flex flex-wrap gap-3">
        {[
          { label: "Avg trust", value: `${avgTrust}%`, color: "text-green-400" },
          { label: "Monthly spend", value: `$${(monthlySpend / 100).toFixed(0)}`, color: "text-blue-400" },
          { label: "Pending approvals", value: String(pendingCount), color: "text-amber-400" },
          { label: "In error state", value: String(errorCount), color: "text-red-400" },
        ].map((m) => (
          <div
            key={m.label}
            className="border border-border bg-card rounded-lg px-4 py-3 min-w-[110px]"
          >
            <div className={cn("text-xl font-bold", m.color)}>{m.value}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{m.label}</div>
          </div>
        ))}
      </div>

      {/* Oversight table */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border">
              {["Agent", "Trust", "Budget", "Can hire", "Approvals", "Last run", "Outcome", "Actions"].map(
                (h) => (
                  <th
                    key={h}
                    className="text-left px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60 whitespace-nowrap"
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const trust = trustMap.get(agent.id) ?? null;
              const hasTrust = hasTrustScoreData(trust);
              const tone = trust ? getTrustScoreTone(trust.currentScore) : null;
              const toneClasses = tone ? getTrustScoreToneClasses(tone) : null;
              const isLead = (agent.runtimeConfig as any)?.aoa?.role === "lead";
              const dotClass = agentStatusDot[agent.status] ?? agentStatusDotDefault;
              const canPause = ["running", "active", "idle"].includes(agent.status);
              const canResume = ["paused", "error"].includes(agent.status);
              const needsApproval = agent.status === "pending_approval";
              const pendingApprovalId =
                (agent.metadata as any)?.pendingApprovalId as string | undefined;

              return (
                <tr
                  key={agent.id}
                  className="border-b border-border/40 last:border-0 hover:bg-white/[0.015] cursor-default"
                >
                  {/* Agent */}
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2.5 min-w-[150px]">
                      <div className="relative w-7 h-7 rounded-md bg-accent flex items-center justify-center shrink-0">
                        <AgentIcon icon={agent.icon} className="h-3.5 w-3.5" />
                        <div
                          className={cn(
                            "absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border-2 border-background",
                            dotClass,
                          )}
                        />
                      </div>
                      <div>
                        <div className="text-[13px] font-semibold leading-none">{agent.name}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {isLead ? "Lead" : "Member"}
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* Trust */}
                  <td className="px-3 py-2.5">
                    {hasTrust && trust && toneClasses ? (
                      <div className="flex items-center gap-1.5 min-w-[80px]">
                        <div className="flex-1 h-1 rounded-full bg-accent overflow-hidden">
                          <div
                            className={cn("h-full rounded-full", toneClasses.progress)}
                            style={{ width: `${trust.currentScore}%` }}
                          />
                        </div>
                        <span className="text-[11px] text-muted-foreground w-8 text-right">
                          {formatTrustScorePercent(trust.currentScore)}
                        </span>
                      </div>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/40">—</span>
                    )}
                  </td>

                  {/* Budget (editable limit) */}
                  <td className="px-3 py-2.5">
                    <BudgetEditCell
                      key={agent.budgetMonthlyCents}
                      agent={agent}
                      isFounder={isFounder}
                      onSave={(cents) => budgetMut.mutate({ id: agent.id, cents })}
                    />
                  </td>

                  {/* Can hire */}
                  <td className="px-3 py-2.5">
                    <CanHireToggle
                      enabled={agent.permissions.canCreateAgents}
                      isFounder={isFounder}
                      onToggle={() =>
                        permMut.mutate({
                          id: agent.id,
                          canCreateAgents: !agent.permissions.canCreateAgents,
                        })
                      }
                    />
                  </td>

                  {/* Approvals */}
                  <td className="px-3 py-2.5">
                    {needsApproval ? (
                      <span className="inline-flex items-center gap-1 bg-amber-950/30 text-amber-300 px-2 py-0.5 rounded-lg text-[11px] font-semibold">
                        ● 1 pending
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/40">—</span>
                    )}
                  </td>

                  {/* Last run */}
                  <td className="px-3 py-2.5">
                    <span className="text-[11px] text-muted-foreground">
                      {relativeTime(agent.lastHeartbeatAt)}
                    </span>
                  </td>

                  {/* Outcome */}
                  <td className="px-3 py-2.5">
                    <StatusBadge status={agent.status} />
                  </td>

                  {/* Actions */}
                  <td className="px-3 py-2.5">
                    {isFounder ? (
                      <div className="flex items-center gap-1.5 flex-nowrap">
                        {canPause && (
                          <button
                            className={cn(
                              "inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium border whitespace-nowrap",
                              "transition-colors",
                              agent.status === "running"
                                ? "border-yellow-500/30 bg-yellow-950/20 text-yellow-300 hover:bg-yellow-950/40"
                                : "border-border bg-card/60 text-muted-foreground hover:bg-accent",
                            )}
                            onClick={() => pauseMut.mutate(agent.id)}
                            disabled={pauseMut.isPending}
                          >
                            ⏸ Pause
                          </button>
                        )}
                        {canResume && (
                          <button
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium border border-border bg-card/60 text-muted-foreground hover:bg-accent whitespace-nowrap transition-colors"
                            onClick={() => resumeMut.mutate(agent.id)}
                            disabled={resumeMut.isPending}
                          >
                            ▶ Resume
                          </button>
                        )}
                        {needsApproval && pendingApprovalId && (
                          <button
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold border border-amber-500/30 bg-amber-950/25 text-amber-300 hover:bg-amber-950/40 whitespace-nowrap transition-colors"
                            onClick={() => approveMut.mutate(pendingApprovalId)}
                            disabled={approveMut.isPending}
                          >
                            ✓ Approve
                          </button>
                        )}
                        <a
                          href={`#/team/aoa/${agent.id}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium border border-border bg-transparent text-muted-foreground hover:bg-card whitespace-nowrap transition-colors"
                          title="Open agent config"
                        >
                          ⚙ Config
                        </a>
                      </div>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/40">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Founder-only notice — shown to non-founders to explain read-only controls */}
      {!isFounder && (
        <p className="flex items-center gap-2 text-[11px] text-muted-foreground/50 border border-border/40 rounded-lg px-3.5 py-2.5">
          <span>🔒</span>
          Budget edits, pause/resume, can-hire toggles, and quick-approvals are{" "}
          <strong className="text-muted-foreground/70">founder-only</strong>.
        </p>
      )}
    </div>
  );
}
