import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { teamsApi } from "../../api/teams";
import { agentsApi } from "../../api/agents";
import { projectsApi } from "../../api/projects";
import { useCompany } from "../../context/CompanyContext";
import { useToast } from "../../context/ToastContext";
import { useNavigate } from "@/lib/router";
import { queryKeys } from "../../lib/queryKeys";
import { MemberRow, type DraftMember } from "./MemberRow";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BuildFromScratchForm({ open, onOpenChange }: Props) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentProjectId, setParentProjectId] = useState<string>("");
  const [members, setMembers] = useState<DraftMember[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Reset form on close
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setName("");
      setDescription("");
      setParentProjectId("");
      setMembers([]);
      setPickerOpen(false);
    }
    onOpenChange(next);
  };

  const projectsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.projects.list(selectedCompanyId)
      : ["projects", "none"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && open,
  });

  const departments = useMemo(
    () => (projectsQuery.data ?? []).filter((p) => p.type === "department"),
    [projectsQuery.data],
  );

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.agents.list(selectedCompanyId)
      : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && open,
  });

  const availableAgents = useMemo(() => {
    const taken = new Set(members.map((m) => m.agentId));
    return (agentsQuery.data ?? []).filter((a) => !taken.has(a.id));
  }, [agentsQuery.data, members]);

  const leadCount = members.filter((m) => m.role === "lead").length;
  const canSubmit =
    Boolean(name.trim()) &&
    Boolean(parentProjectId) &&
    members.length > 0 &&
    leadCount === 1;

  const createMut = useMutation({
    mutationFn: async () => {
      const team = await teamsApi.create(selectedCompanyId!, {
        name,
        parentProjectId,
        description: description || undefined,
        members: members.map((m) => ({ agentId: m.agentId, role: m.role })),
      });

      // Trigger initial coordination.md scaffolding.
      // Soft-fail: if scaffolding fails, the team still exists. User can
      // retry from the team detail page via the "Regenerate" button.
      try {
        await teamsApi.regenerateCoordination(team.id);
      } catch (err) {
        console.warn(
          "Coordination scaffolding failed for team",
          team.id,
          err,
        );
        pushToast({
          title: "Team created",
          body: "Coordination scaffolding deferred — open the team page to retry.",
          tone: "warn",
        });
      }

      return team;
    },
    onSuccess: (team) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.teams.list(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.list(selectedCompanyId!),
      });
      // C3 (comprehensive-review fixup): the dept-detail page reads
      // queryKeys.projects.agents(projectId) for its agent dropdown — this
      // cache is independent of agents.list and projects.list and was
      // missed in the original Task 6 invalidation set.
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.agents(parentProjectId),
      });
      pushToast({
        title: "Team created",
        body: `"${team.name}" is ready.`,
        tone: "success",
      });
      handleOpenChange(false);
      navigate(`/team/teams/${team.slug}`);
    },
    onError: (err) => {
      pushToast({
        title: "Failed to create team",
        body: (err as Error).message,
        tone: "error",
      });
    },
  });

  const summary = "Will create: 1 team · 1 coordination.md";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>New team</DialogTitle>
          <DialogDescription>
            Build from scratch — pick existing agents or create new ones inline.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex-1 overflow-y-auto space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="team-name">Team name *</Label>
              <Input
                id="team-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Frontend Team"
              />
            </div>
            <div>
              <Label htmlFor="team-dept">Parent department *</Label>
              <Select
                value={parentProjectId}
                onValueChange={setParentProjectId}
              >
                <SelectTrigger id="team-dept">
                  <SelectValue placeholder="Pick a department" />
                </SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="team-desc">
              Description{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="team-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this team handle?"
              rows={2}
            />
          </div>

          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold">
                Members{" "}
                <span className="text-xs font-medium text-muted-foreground">
                  {members.length} added
                </span>
              </h3>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPickerOpen(!pickerOpen)}
              >
                <Search className="h-3.5 w-3.5 mr-1" />
                Add agent
              </Button>
            </div>

            {pickerOpen && (
              <div className="mb-2 max-h-40 overflow-y-auto rounded border bg-card p-2">
                {availableAgents.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No more available agents.
                  </p>
                ) : (
                  availableAgents.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="block w-full rounded p-2 text-left text-xs hover:bg-accent"
                      onClick={() => {
                        setMembers([
                          ...members,
                          { agentId: a.id, name: a.name, role: "member" },
                        ]);
                        setPickerOpen(false);
                      }}
                    >
                      <span className="font-bold">{a.name}</span>
                      <span className="ml-2 text-muted-foreground">
                        {a.role}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}

            {members.map((m, idx) => (
              <MemberRow
                key={m.agentId}
                member={m}
                onChange={(updated) => {
                  const copy = [...members];
                  copy[idx] = updated;
                  setMembers(copy);
                }}
                onRemove={() =>
                  setMembers(members.filter((_, i) => i !== idx))
                }
              />
            ))}

            {members.length === 0 && (
              <p className="text-center text-xs text-muted-foreground py-3">
                Add at least one member.
              </p>
            )}

          </div>

          {leadCount !== 1 && members.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Exactly one member must be the Lead. Currently: {leadCount}.
            </p>
          )}
        </DialogBody>

        <DialogFooter className="border-t pt-3 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{summary}</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMut.mutate()}
              disabled={!canSubmit || createMut.isPending}
            >
              {createMut.isPending ? "Creating..." : "Create team →"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

