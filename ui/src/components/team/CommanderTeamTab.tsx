import { useState, type ReactNode } from "react";
import type { Agent, AgentTrustScore } from "@armyofagents/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "../../lib/utils";
import { Bot, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { NewAoaAgentDialog } from "./NewAoaAgentDialog";
import { CommanderRosterTab } from "./CommanderRosterTab";
import { CommanderKanbanTab } from "./CommanderKanbanTab";
import { CommanderGovernanceTab } from "./CommanderGovernanceTab";
import type { LiveRunForIssue } from "../../api/heartbeats";

export type AoaTeamSubTab = "roster" | "tasks" | "kanban" | "governance";

interface CommanderTeamTabPermissions {
  isFounder: boolean;
}

interface CommanderTeamTabProps {
  agents: Agent[];
  trustScores: AgentTrustScore[];
  liveRuns: LiveRunForIssue[];
  permissions: CommanderTeamTabPermissions;
  onMutationSuccess?: () => void;
  activeSubTab?: AoaTeamSubTab;
  onSubTabChange?: (tab: AoaTeamSubTab) => void;
  tasksContent?: ReactNode;
  showSubTabs?: boolean;
}

export const AOA_TEAM_SUB_TABS: { id: AoaTeamSubTab; label: string }[] = [
  { id: "roster", label: "Roster" },
  { id: "tasks", label: "Tasks" },
  { id: "kanban", label: "Kanban" },
  { id: "governance", label: "Governance" },
];

export function CommanderTeamTab({
  agents,
  trustScores,
  liveRuns,
  permissions,
  onMutationSuccess,
  activeSubTab,
  onSubTabChange,
  tasksContent,
  showSubTabs = true,
}: CommanderTeamTabProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [internalSubTab, setInternalSubTab] = useState<AoaTeamSubTab>("roster");
  const [dialogOpen, setDialogOpen] = useState(false);
  const currentSubTab = activeSubTab ?? internalSubTab;

  function handleNewAoaAgent() {
    setDialogOpen(true);
  }

  function handleDialogSuccess() {
    queryClient.invalidateQueries({ queryKey: ["aoa-agents", selectedCompanyId] });
    onMutationSuccess?.();
  }

  function handleGovernanceMutation() {
    queryClient.invalidateQueries({ queryKey: ["aoa-agents", selectedCompanyId] });
    onMutationSuccess?.();
  }

  function selectSubTab(tab: AoaTeamSubTab) {
    if (onSubTabChange) onSubTabChange(tab);
    else setInternalSubTab(tab);
  }

  return (
    <>
      <div className="px-5 pt-4">
        {showSubTabs && (
          <div className="mb-4 flex gap-0 border-b border-border">
            {AOA_TEAM_SUB_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => selectSubTab(tab.id)}
                data-testid={`commander-subtab-${tab.id}`}
                data-active={currentSubTab === tab.id ? "true" : undefined}
                className={cn(
                  "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                  currentSubTab === tab.id
                    ? "border-brand text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {/* Sub-tab content */}
        {currentSubTab === "roster" && agents.length === 0 && (
          <EmptyState
            icon={<Bot />}
            title="No AoA agents yet"
            description="Deploy your first Commander or AoA member agent to build your autonomous team."
            action={
              permissions.isFounder ? (
                <Button size="sm" onClick={handleNewAoaAgent}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  New AoA Agent
                </Button>
              ) : undefined
            }
          />
        )}
        {currentSubTab === "roster" && agents.length > 0 && (
          <CommanderRosterTab
            agents={agents}
            trustScores={trustScores}
            isFounder={permissions.isFounder}
            onNewAgent={handleNewAoaAgent}
          />
        )}
        {currentSubTab === "tasks" && (
          <div data-testid="tasks-content">
            {tasksContent}
          </div>
        )}
        {currentSubTab === "kanban" && (
          <CommanderKanbanTab agents={agents} liveRuns={liveRuns} />
        )}
        {currentSubTab === "governance" && (
          <CommanderGovernanceTab
            agents={agents}
            trustScores={trustScores}
            isFounder={permissions.isFounder}
            onMutationSuccess={handleGovernanceMutation}
          />
        )}
      </div>

      {selectedCompanyId && (
        <NewAoaAgentDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          companyId={selectedCompanyId}
          onSuccess={handleDialogSuccess}
        />
      )}
    </>
  );
}
