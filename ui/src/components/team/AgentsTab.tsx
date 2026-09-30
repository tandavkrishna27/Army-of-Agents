import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, AgentTrustScore } from "@armyofagents/shared";
import type { OrgNode } from "../../api/agents";
import { agentsApi } from "../../api/agents";
import { useCompany } from "../../context/CompanyContext";
import { useDialog } from "../../context/DialogContext";
import { useToast } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { AgentCard } from "../AgentCard";

import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Bot,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react";

interface AgentsTabPermissions {
  isFounder: boolean;
}

interface AgentsTabProps {
  agents: Agent[];
  /**
   * @deprecated No longer consumed — `<AgentCard>` resolves its own metadata.
   * Kept on the interface for now so the parent (`TeamPage`) compiles without
   * a coordinated change. Drop after the next AgentsTab API audit.
   */
  orgTree?: OrgNode[];
  highlightId?: string | null;
  permissions: AgentsTabPermissions;
  trustScores?: Map<string, AgentTrustScore>;
  onMutationSuccess?: () => void;
}

export function AgentsTab({ agents, permissions, trustScores, onMutationSuccess }: AgentsTabProps) {
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [confirmAction, setConfirmAction] = useState<{ type: "terminate" | "delete"; agent: Agent } | null>(null);

  const terminateAgent = useMutation({
    mutationFn: (agent: Agent) =>
      agentsApi.terminate(agent.id, selectedCompanyId ?? undefined),
    onSuccess: (_, agent) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      onMutationSuccess?.();
      pushToast({ title: "Agent terminated", body: agent.name, tone: "success" });
      setConfirmAction(null);
    },
    onError: (error) => {
      pushToast({
        title: "Terminate failed",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const deleteAgent = useMutation({
    mutationFn: (agent: Agent) =>
      agentsApi.remove(agent.id, selectedCompanyId ?? undefined),
    onSuccess: (_, agent) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      onMutationSuccess?.();
      pushToast({ title: "Agent deleted", body: agent.name, tone: "success" });
      setConfirmAction(null);
    },
    onError: (error) => {
      pushToast({
        title: "Delete failed",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  if (agents.length === 0) {
    return (
      <EmptyState
        icon={<Bot />}
        title="No agents yet"
        description="Hire your first agent. Pick a Claude / Codex / OpenClaw adapter and assign a role."
        action={
          permissions.isFounder ? (
            <Button size="sm" onClick={openNewAgent}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Agent
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="p-5 space-y-4">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold">
            Agents <span className="ml-1 text-xs font-medium text-muted-foreground">{agents.length}</span>
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">All agents in this department</p>
        </div>
        {permissions.isFounder && (
          <Button size="sm" variant="outline" onClick={openNewAgent}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Agent
          </Button>
        )}
      </header>

      {/* Agent cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent) => {
          const isTerminated = agent.status === "terminated";
          const score = trustScores?.get(agent.id) ?? null;

          return (
            <div
              key={agent.id}
              data-testid={`agent-card-${agent.id}`}
              className="rounded-lg"
            >
              <AgentCard
                agent={agent}
                trustScore={score}
                dropdownExtras={
                  <>
                    {!isTerminated && (
                      <DropdownMenuItem
                        onClick={() => setConfirmAction({ type: "terminate", agent })}
                        className="text-orange-600 dark:text-orange-400"
                      >
                        <XCircle className="h-3.5 w-3.5 mr-2" />
                        Terminate
                      </DropdownMenuItem>
                    )}
                    {permissions.isFounder && (
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setConfirmAction({ type: "delete", agent })}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    )}
                  </>
                }
              />
            </div>
          );
        })}
      </div>

      {/* Edit Agent Dialog */}
      {/* Confirmation Dialog */}
      {confirmAction && (
        <ConfirmActionDialog
          type={confirmAction.type}
          agentName={confirmAction.agent.name}
          isPending={confirmAction.type === "terminate" ? terminateAgent.isPending : deleteAgent.isPending}
          onConfirm={() => {
            if (confirmAction.type === "terminate") {
              terminateAgent.mutate(confirmAction.agent);
            } else {
              deleteAgent.mutate(confirmAction.agent);
            }
          }}
          onCancel={() => setConfirmAction(null)}
          isFounder={permissions.isFounder}
        />
      )}
    </div>
  );
}

function ConfirmActionDialog({
  type,
  agentName,
  isPending,
  onConfirm,
  onCancel,
  isFounder,
}: {
  type: "terminate" | "delete";
  agentName: string;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  isFounder: boolean;
}) {
  const isTerminate = type === "terminate";

  // Delete requires founder
  if (type === "delete" && !isFounder) {
    return null;
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isTerminate ? "Terminate agent" : "Delete agent"}
          </DialogTitle>
          <DialogDescription>
            {isTerminate
              ? `Are you sure you want to terminate "${agentName}"? The agent will stop all work and cannot be resumed.`
              : `Are you sure you want to permanently delete "${agentName}"? This action cannot be undone.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending
              ? (isTerminate ? "Terminating\u2026" : "Deleting\u2026")
              : (isTerminate ? "Terminate" : "Delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
