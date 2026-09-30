import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useChangeLayerMutation } from "../../lib/memoryFolderMutations";
import { projectsApi } from "../../api/projects";
import { goalsApi } from "../../api/goals";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import type { MemoryItem, Project, Goal } from "@armyofagents/shared";

type Layer = "identity" | "domain" | "active_context" | "working";

interface ChangeLayerDialogProps {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: MemoryItem;
}

export function ChangeLayerDialog({
  companyId,
  open,
  onOpenChange,
  item,
}: ChangeLayerDialogProps) {
  const [newLayer, setNewLayer] = useState<Layer>(
    (item.layer as Layer) ?? "domain",
  );
  const [departmentId, setDepartmentId] = useState<string>(
    item.departmentId ?? "",
  );
  const [goalId, setGoalId] = useState<string>(item.goalId ?? "");
  const [taskId, setTaskId] = useState<string>(item.taskId ?? "");
  const [expiresAt, setExpiresAt] = useState<string>(
    item.expiresAt instanceof Date
      ? item.expiresAt.toISOString().slice(0, 10)
      : "",
  );
  const [error, setError] = useState<string | null>(null);

  const mutation = useChangeLayerMutation(companyId);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: open,
  });
  const goalsQuery = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
    enabled: open && newLayer === "active_context",
  });
  const issuesQuery = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
    enabled: open && newLayer === "working",
  });

  const departments = useMemo(
    () =>
      (projectsQuery.data ?? []).filter(
        (p: Project) => p.type === "department" && !p.archivedAt,
      ),
    [projectsQuery.data],
  );
  const activeGoals = useMemo(
    () =>
      ((goalsQuery.data ?? []) as Goal[]).filter(
        (g) => g.status === "active",
      ),
    [goalsQuery.data],
  );
  const tasks = useMemo(
    () => (issuesQuery.data ?? []).slice(0, 50),
    [issuesQuery.data],
  );

  useEffect(() => {
    if (open) {
      setNewLayer((item.layer as Layer) ?? "domain");
      setDepartmentId(item.departmentId ?? "");
      setGoalId(item.goalId ?? "");
      setTaskId(item.taskId ?? "");
      setExpiresAt(
        item.expiresAt instanceof Date
          ? item.expiresAt.toISOString().slice(0, 10)
          : "",
      );
      setError(null);
    }
  }, [open, item]);

  const canSave = (() => {
    if (newLayer === "active_context" && !goalId) return false;
    if (newLayer === "working" && !taskId) return false;
    return true;
  })();

  async function handleSave() {
    setError(null);
    try {
      await mutation.mutateAsync({
        id: item.id,
        input: {
          newLayer,
          departmentId:
            newLayer === "domain" || newLayer === "active_context" || newLayer === "working"
              ? departmentId || null
              : null,
          goalId: newLayer === "active_context" ? goalId : null,
          taskId: newLayer === "working" ? taskId : null,
          expiresAt:
            newLayer === "active_context" && expiresAt
              ? new Date(expiresAt + "T23:59:59Z").toISOString()
              : null,
        },
      });
      onOpenChange(false);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Failed to change layer");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change layer</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="layer-select">Layer</Label>
            <Select
              value={newLayer}
              onValueChange={(v) => setNewLayer(v as Layer)}
            >
              <SelectTrigger id="layer-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="identity">Identity</SelectItem>
                <SelectItem value="domain">Domain</SelectItem>
                <SelectItem value="active_context">Active Context</SelectItem>
                <SelectItem value="working">Working</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {newLayer === "identity" && (
            <div className="text-xs text-muted-foreground bg-muted/40 rounded p-3">
              <strong>Permanent layer.</strong> Agent context will always include
              this item, regardless of department or goal scope.
            </div>
          )}

          {(newLayer === "domain" || newLayer === "active_context" || newLayer === "working") && (
            <div className="space-y-1.5">
              <Label htmlFor="dept-select">Department</Label>
              <Select value={departmentId} onValueChange={setDepartmentId}>
                <SelectTrigger id="dept-select">
                  <SelectValue placeholder="Select department" />
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
          )}

          {newLayer === "active_context" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="goal-select">Goal</Label>
                <Select value={goalId} onValueChange={setGoalId}>
                  <SelectTrigger id="goal-select">
                    <SelectValue placeholder="Select active goal" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeGoals.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="expires-input">Expires (optional)</Label>
                <Input
                  id="expires-input"
                  type="date"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </div>
            </>
          )}

          {newLayer === "working" && (
            <div className="space-y-1.5">
              <Label htmlFor="task-select">Task</Label>
              <Select value={taskId} onValueChange={setTaskId}>
                <SelectTrigger id="task-select">
                  <SelectValue placeholder="Select task" />
                </SelectTrigger>
                <SelectContent>
                  {tasks.map((t: { id: string; title: string; identifier?: string | null }) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.identifier ? `${t.identifier} · ` : ""}
                      {t.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {error && (
            <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
