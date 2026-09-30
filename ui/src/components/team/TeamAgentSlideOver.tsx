import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Star, Settings, History } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentIcon } from "../AgentIconPicker";
import { StatusBadge } from "../StatusBadge";
import { TrustScoreBadge } from "../TrustScoreBadge";
import { adapterLabels, roleLabels } from "../agent-config-primitives";
import { relativeTime, agentUrl, agentRouteRef } from "../../lib/utils";
import { trustScoresApi } from "../../api/trust-scores";
import { teamsApi, type TeamMember } from "../../api/teams";
import { useCompany } from "../../context/CompanyContext";
import { useNavigate } from "@/lib/router";
import { queryKeys } from "../../lib/queryKeys";
import type { Agent } from "@armyofagents/shared";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent | null;
  teamId: string;
  teamMember?: TeamMember | null;
}

export function TeamAgentSlideOver({ open, onOpenChange, agent, teamId, teamMember }: Props) {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();

  const trustQuery = useQuery({
    queryKey: selectedCompanyId && agent
      ? ["trust-score", selectedCompanyId, agent.id]
      : ["trust-score", "none"],
    queryFn: () => trustScoresApi.get(selectedCompanyId!, agent!.id),
    enabled: Boolean(open && selectedCompanyId && agent),
  });

  const memberQuery = useQuery({
    queryKey: agent ? queryKeys.teams.member(teamId, agent.id) : ["team-member", "none"],
    queryFn: () => teamsApi.getMember(teamId, agent!.id),
    enabled: Boolean(open && agent && !teamMember),
    initialData: teamMember ?? undefined,
  });

  if (!agent) return null;

  const agentRef = agentRouteRef(agent);
  const member = memberQuery.data ?? teamMember;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[380px] sm:w-[420px] flex flex-col gap-0 p-0">
        <SheetHeader className="px-5 pt-5 pb-4 border-b">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent shrink-0">
              <AgentIcon icon={agent.icon} className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-base font-semibold truncate">{agent.name}</SheetTitle>
              <SheetDescription className="text-xs">
                {roleLabels[agent.role] ?? agent.role}
                {agent.title ? ` · ${agent.title}` : ""}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Team role */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Team role</span>
            {member ? (
              <span className="flex items-center gap-1 text-xs font-medium">
                {member.role === "lead" && (
                  <Star className="h-3 w-3 text-amber-500" aria-hidden="true" />
                )}
                {member.role === "lead" ? "Lead" : "Member"}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </div>

          {/* Status */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Status</span>
            <StatusBadge status={agent.status} />
          </div>

          {/* Adapter */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Adapter</span>
            <Badge variant="outline" className="font-mono text-[10px]">
              {adapterLabels[agent.adapterType] ?? agent.adapterType}
            </Badge>
          </div>

          {/* Trust score */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Trust score</span>
            <TrustScoreBadge score={trustQuery.data ?? null} />
          </div>

          {/* Last active */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Last active</span>
            <span className="text-xs">
              {agent.lastHeartbeatAt
                ? relativeTime(agent.lastHeartbeatAt)
                : "Never"}
            </span>
          </div>

          {/* Skills */}
          {agent.skillKeys && agent.skillKeys.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs text-muted-foreground">Skills</p>
              <div className="flex flex-wrap gap-1">
                {agent.skillKeys.map((k) => (
                  <Badge key={k} variant="secondary" className="text-[10px]">
                    {k}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="border-t px-5 py-4 flex flex-col gap-2">
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => {
              onOpenChange(false);
              navigate(`/agents/${agentRef}/configure`);
            }}
          >
            <Settings className="h-3.5 w-3.5 mr-2" />
            Configure agent
          </Button>
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => {
              onOpenChange(false);
              navigate(`/agents/${agentRef}/runs`);
            }}
          >
            <History className="h-3.5 w-3.5 mr-2" />
            View runs
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start text-muted-foreground"
            onClick={() => {
              onOpenChange(false);
              navigate(agentUrl(agent));
            }}
          >
            <ExternalLink className="h-3.5 w-3.5 mr-2" />
            Open full page
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
