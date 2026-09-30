import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Wallet } from "lucide-react";
import type { Agent } from "@armyofagents/shared";
import { budgetsApi } from "../../api/budgets";
import { agentsApi } from "../../api/agents";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type ScopeType = "company" | "agent";

export interface CreateBudgetPolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}

export function CreateBudgetPolicyDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateBudgetPolicyDialogProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const [scopeType, setScopeType] = useState<ScopeType>("company");
  const [scopeAgentId, setScopeAgentId] = useState<string>("");
  const [amountDollars, setAmountDollars] = useState<string>("100");
  const [warnPercent, setWarnPercent] = useState<number>(80);
  const [hardStopEnabled, setHardStopEnabled] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open && scopeType === "agent",
  });

  const activeAgents = useMemo<Agent[]>(
    () => (agentsQuery.data ?? []).filter((a) => a.status !== "terminated"),
    [agentsQuery.data],
  );

  const amountCents = useMemo(() => {
    const n = Number.parseFloat(amountDollars);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
  }, [amountDollars]);

  const createMutation = useMutation({
    mutationFn: () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      if (amountCents == null) throw new Error("Enter a valid amount");
      const scopeId = scopeType === "company" ? selectedCompanyId : scopeAgentId;
      if (!scopeId) throw new Error("Pick an agent for agent-scoped policies");
      return budgetsApi.upsertPolicy(selectedCompanyId, {
        scopeType,
        scopeId,
        amountCents,
        warnPercent,
        hardStopEnabled,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budgets", "overview", selectedCompanyId] });
      reset();
      onOpenChange(false);
      onCreated?.();
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : "Failed to create budget policy");
    },
  });

  function reset() {
    setScopeType("company");
    setScopeAgentId("");
    setAmountDollars("100");
    setWarnPercent(80);
    setHardStopEnabled(true);
    setError(null);
  }

  const canSubmit =
    amountCents != null &&
    amountCents >= 0 &&
    warnPercent >= 1 &&
    warnPercent <= 99 &&
    (scopeType === "company" || scopeAgentId);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4" />
            New Budget Policy
          </DialogTitle>
          <DialogDescription>
            Cap monthly spend for the whole company or a single agent. Upserts an existing policy
            at the same scope.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {/* Scope type */}
          <div className="space-y-2">
            <Label>Scope</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-sm transition-colors",
                  scopeType === "company"
                    ? "border-foreground bg-accent/40"
                    : "border-border hover:bg-accent/30",
                )}
                onClick={() => setScopeType("company")}
              >
                <div className="font-medium">Company</div>
                <div className="text-xs text-muted-foreground">
                  Caps total spend across all agents.
                </div>
              </button>
              <button
                type="button"
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-sm transition-colors",
                  scopeType === "agent"
                    ? "border-foreground bg-accent/40"
                    : "border-border hover:bg-accent/30",
                )}
                onClick={() => setScopeType("agent")}
              >
                <div className="font-medium">Agent</div>
                <div className="text-xs text-muted-foreground">
                  Caps spend for one agent only.
                </div>
              </button>
            </div>
          </div>

          {/* Agent picker */}
          {scopeType === "agent" && (
            <div className="space-y-2">
              <Label htmlFor="budget-policy-agent">Agent</Label>
              <select
                id="budget-policy-agent"
                className="w-full h-9 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                value={scopeAgentId}
                onChange={(e) => setScopeAgentId(e.target.value)}
              >
                <option value="">Select an agent…</option>
                {activeAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} {a.role ? `· ${a.role}` : ""}
                  </option>
                ))}
              </select>
              {agentsQuery.isLoading && (
                <p className="text-xs text-muted-foreground">Loading agents…</p>
              )}
              {!agentsQuery.isLoading && activeAgents.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No active agents in this company yet.
                </p>
              )}
            </div>
          )}

          {/* Amount */}
          <div className="space-y-2">
            <Label htmlFor="budget-policy-amount">Monthly limit (USD)</Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">$</span>
              <Input
                id="budget-policy-amount"
                type="number"
                min="0"
                step="1"
                inputMode="decimal"
                value={amountDollars}
                onChange={(e) => setAmountDollars(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Resets every calendar month (UTC). Set to 0 to disable the cap while keeping the policy.
            </p>
          </div>

          {/* Warn percent */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="budget-policy-warn">Warn at</Label>
              <span className="text-sm tabular-nums text-muted-foreground">{warnPercent}%</span>
            </div>
            <input
              id="budget-policy-warn"
              type="range"
              min={1}
              max={99}
              step={1}
              value={warnPercent}
              onChange={(e) => setWarnPercent(Number(e.target.value))}
              className="w-full accent-foreground"
            />
          </div>

          {/* Hard stop */}
          <label className="flex items-start gap-2 rounded-md border border-border p-3 cursor-pointer">
            <input
              type="checkbox"
              checked={hardStopEnabled}
              onChange={(e) => setHardStopEnabled(e.target.checked)}
              className="mt-0.5 accent-foreground"
            />
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Hard stop when exceeded</p>
              <p className="text-xs text-muted-foreground">
                Block new agent runs once observed spend passes the limit. Disable to warn only.
              </p>
            </div>
          </label>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </DialogBody>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={!canSubmit || createMutation.isPending}
            onClick={() => {
              setError(null);
              createMutation.mutate();
            }}
          >
            {createMutation.isPending ? "Creating…" : (
              <span className="inline-flex items-center gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Create policy
              </span>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
