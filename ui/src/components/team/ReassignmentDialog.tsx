import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MemberDependencies, TeamMemberSummary } from "@armyofagents/shared";
import { teamApi } from "../../api/team";
import { queryKeys } from "../../lib/queryKeys";
import { useToast } from "../../context/ToastContext";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

interface ReassignmentDialogProps {
  companyId: string;
  member: TeamMemberSummary;
  allMembers: TeamMemberSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function ReassignmentDialog({
  companyId,
  member,
  allMembers,
  open,
  onOpenChange,
  onSuccess,
}: ReassignmentDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const { data: deps, isLoading } = useQuery({
    queryKey: queryKeys.team.dependencies(companyId, member.userId),
    queryFn: () => teamApi.getDependencies(companyId, member.userId),
    enabled: open,
  });

  const otherMembers = useMemo(
    () => allMembers.filter((m) => m.userId !== member.userId),
    [allMembers, member.userId],
  );

  // Human reassignment: individual dropdowns
  const [humanTargets, setHumanTargets] = useState<Record<string, string>>({});
  // Agent reassignment: bulk target
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [agentBulkTarget, setAgentBulkTarget] = useState<string>("none");

  useEffect(() => {
    if (deps) {
      // Initialize human targets to "none" (root)
      const initial: Record<string, string> = {};
      for (const tm of deps.teamMembers) {
        initial[tm.userId] = "none";
      }
      setHumanTargets(initial);
      // Select all agents by default
      setSelectedAgents(new Set(deps.agentTrees.map((a) => a.rootAgentId)));
    }
  }, [deps]);

  const hasDependencies =
    deps &&
    (deps.teamMembers.length > 0 || deps.agentTrees.length > 0);

  const canSubmit =
    deps &&
    deps.teamMembers.every((tm) => humanTargets[tm.userId] !== undefined) &&
    (deps.agentTrees.length === 0 || selectedAgents.size === 0 || agentBulkTarget !== "none");

  const removeMutation = useMutation({
    mutationFn: () => {
      const humanReassignments = (deps?.teamMembers ?? []).map((tm) => ({
        userId: tm.userId,
        newParentId: humanTargets[tm.userId] === "none" ? null : (humanTargets[tm.userId] ?? null),
      }));

      const agentReassignments = (deps?.agentTrees ?? [])
        .filter((a) => selectedAgents.has(a.rootAgentId))
        .map((a) => ({
          agentId: a.rootAgentId,
          newParentId: agentBulkTarget,
          newParentType: "user" as const,
        }));

      return teamApi.reassignAndRemove(companyId, member.userId, {
        humanReassignments,
        agentReassignments,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.team.summary(companyId) });
      pushToast({ title: "Team member removed", tone: "success" });
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to remove member", body: err.message, tone: "error" });
    },
  });

  const displayName = member.displayName ?? member.email ?? member.userId.slice(0, 8);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove {displayName}</DialogTitle>
          <DialogDescription>
            {hasDependencies
              ? "Reassign reports and agents before removing this member."
              : `Are you sure you want to remove ${displayName} from the team?`}
          </DialogDescription>
        </DialogHeader>

        {isLoading && <div className="py-4 text-sm text-muted-foreground">Loading dependencies...</div>}

        {deps && (
          <DialogBody className="space-y-4 max-h-[400px] overflow-y-auto">
            {deps.teamMembers.length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm font-semibold">Team members reporting to {displayName}</Label>
                {deps.teamMembers.map((tm) => (
                  <div key={tm.userId} className="flex items-center gap-2">
                    <span className="text-sm min-w-[120px]">
                      {tm.displayName ?? tm.email ?? tm.userId.slice(0, 8)}
                    </span>
                    <Select
                      value={humanTargets[tm.userId] ?? "none"}
                      onValueChange={(v) =>
                        setHumanTargets((prev) => ({ ...prev, [tm.userId]: v }))
                      }
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No manager (root)</SelectItem>
                        {otherMembers
                          .filter((m) => m.userId !== tm.userId)
                          .map((m) => (
                            <SelectItem key={m.userId} value={m.userId}>
                              {m.displayName ?? m.email ?? m.userId.slice(0, 8)}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            )}

            {deps.agentTrees.length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm font-semibold">Agent trees under {displayName}</Label>
                {deps.agentTrees.map((tree) => (
                  <div key={tree.rootAgentId} className="flex items-center gap-2">
                    <Checkbox
                      checked={selectedAgents.has(tree.rootAgentId)}
                      onCheckedChange={(checked) => {
                        setSelectedAgents((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(tree.rootAgentId);
                          else next.delete(tree.rootAgentId);
                          return next;
                        });
                      }}
                    />
                    <span className="text-sm">
                      {tree.rootAgentName}
                      {tree.subAgentCount > 0 && (
                        <span className="text-muted-foreground"> (+{tree.subAgentCount} sub-agents)</span>
                      )}
                    </span>
                  </div>
                ))}

                {selectedAgents.size > 0 && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Reassign selected agents to:</Label>
                    <Select value={agentBulkTarget} onValueChange={setAgentBulkTarget}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select new owner" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Select new owner</SelectItem>
                        {otherMembers.map((m) => (
                          <SelectItem key={m.userId} value={m.userId}>
                            {m.displayName ?? m.email ?? m.userId.slice(0, 8)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}

            {(deps.assignedTaskCount > 0 || deps.createdTaskCount > 0) && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
                <span className="font-medium">Open tasks:</span>{" "}
                {deps.assignedTaskCount} assigned, {deps.createdTaskCount} created.
                These will remain but lose their assignee/creator link.
              </div>
            )}
          </DialogBody>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={removeMutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => removeMutation.mutate()}
            disabled={removeMutation.isPending || isLoading || !canSubmit}
          >
            {removeMutation.isPending ? "Removing..." : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
