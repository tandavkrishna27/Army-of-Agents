/**
 * NewThreadDialog — adaptive dialog for creating new threads.
 *
 * Type chooser: Idea / Discussion / Goal / Transcript / Document
 * Fields adapt via resolveCreateTarget().
 * Goal type: creates discussion + promoteToGoal (Codex #2).
 * Other types: call discussionsApi.create directly.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { discussionsApi } from "../api/discussions";
import { threadsApi } from "../api/threads";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import {
  resolveCreateTarget,
  type NewThreadType,
} from "./threads/newThreadModel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

/* ─── Constants ─── */

const THREAD_TYPES: { key: NewThreadType; label: string; description: string }[] = [
  { key: "idea", label: "Idea", description: "A raw idea to explore" },
  { key: "discussion", label: "Discussion", description: "A structured discussion" },
  { key: "goal", label: "Goal", description: "Creates a thread + linked goal" },
  { key: "transcript", label: "Transcript", description: "Meeting or voice recording" },
  { key: "document", label: "Document", description: "Paste or import a document" },
];

const GOAL_LEVELS = ["company", "team", "agent", "task"] as const;
type GoalLevel = (typeof GOAL_LEVELS)[number];

/* ════════════════════════════════════════════════════════════════════════
   NewThreadDialog
   ════════════════════════════════════════════════════════════════════════ */

interface NewThreadDialogProps {
  open: boolean;
  onClose: () => void;
  defaults?: {
    title?: string;
    scopeType?: string;
    scopeId?: string;
    initialType?: NewThreadType;
  };
}

export function NewThreadDialog({ open, onClose, defaults = {} }: NewThreadDialogProps) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [selectedType, setSelectedType] = useState<NewThreadType>(
    defaults.initialType ?? "idea",
  );
  const [title, setTitle] = useState(defaults.title ?? "");
  const [description, setDescription] = useState("");
  const [goalLevel, setGoalLevel] = useState<GoalLevel>("team");
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);

  const target = resolveCreateTarget(selectedType);

  const canCreate = title.trim().length > 0 || description.trim().length > 0;

  // Load projects for goal type
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? ""),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && selectedType === "goal",
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) throw new Error("No company selected");

      // The shared type restricts scopeType to a specific union — cast safely
      type AllowedScopeType = "department" | "project" | "goal";
      const scopeType = defaults.scopeType as AllowedScopeType | undefined;

      if (target.backend === "thread+goal") {
        // Codex #2: create discussion first, then promoteToGoal
        const disc = await discussionsApi.create(selectedCompanyId, {
          title: title.trim() || "New Goal Thread",
          ...(scopeType && { scopeType }),
          ...(defaults.scopeId && { scopeId: defaults.scopeId }),
        });
        if (description.trim()) {
          await discussionsApi.addEntry(selectedCompanyId, disc.id, {
            rawContent: description.trim(),
            inputType: "write",
          });
        }
        await threadsApi.promoteToGoal(selectedCompanyId, disc.id, {
          level: goalLevel,
          projectIds: selectedProjectIds,
        });
        return disc;
      }

      const thread = await discussionsApi.create(selectedCompanyId, {
        title: title.trim() || `New ${selectedType}`,
        ...(scopeType && { scopeType }),
        ...(defaults.scopeId && { scopeId: defaults.scopeId }),
      });
      if (description.trim()) {
        await discussionsApi.addEntry(selectedCompanyId, thread.id, {
          rawContent: description.trim(),
          inputType: "write",
        });
      }
      return thread;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discussions.list(selectedCompanyId ?? "") });
      queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(selectedCompanyId ?? "") });
      queryClient.invalidateQueries({ queryKey: ["threads", selectedCompanyId ?? ""] });
      pushToast({ title: "Thread created", tone: "success" });
      onClose();
    },
    onError: () => {
      pushToast({ title: "Failed to create thread", tone: "warn" });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createMutation.mutate();
  }

  function toggleProjectId(id: string) {
    setSelectedProjectIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Thread</DialogTitle>
          <DialogDescription>
            Start a discussion, explore an idea, or launch a goal-linked thread.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          {/* Type chooser */}
          <div>
            <label htmlFor="thread-type-group" className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 block">
              Type
            </label>
            <div id="thread-type-group" className="flex flex-wrap gap-2" role="group" aria-label="Thread type">
              {THREAD_TYPES.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={selectedType === key}
                  onClick={() => setSelectedType(key)}
                  className={cn(
                    "inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-colors",
                    selectedType === key
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground hover:bg-muted/80",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div>
            <label htmlFor="thread-title" className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Title
            </label>
            <Input
              id="thread-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`${THREAD_TYPES.find((t) => t.key === selectedType)?.description ?? ""}...`}
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <label htmlFor="thread-description" className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Description
            </label>
            <Textarea
              id="thread-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's on your mind?"
              rows={3}
              className="resize-none"
            />
          </div>

          {/* Goal-specific fields */}
          {target.backend === "thread+goal" && (
            <div className="space-y-3">
              {/* Level */}
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                  Goal Level
                </label>
                <div className="flex flex-wrap gap-2">
                  {GOAL_LEVELS.map((level) => (
                    <button
                      key={level}
                      type="button"
                      aria-pressed={goalLevel === level}
                      onClick={() => setGoalLevel(level)}
                      className={cn(
                        "inline-flex items-center rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors",
                        goalLevel === level
                          ? "bg-foreground text-background"
                          : "bg-muted text-muted-foreground hover:bg-muted/80",
                      )}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>

              {/* Projects — required for goal */}
              <div data-testid="thread-goal-project-field">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                  Projects (required)
                </label>
                {projects && projects.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        aria-pressed={selectedProjectIds.includes(p.id)}
                        onClick={() => toggleProjectId(p.id)}
                        className={cn(
                          "inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors border",
                          selectedProjectIds.includes(p.id)
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-card text-muted-foreground border-border hover:border-muted-foreground",
                        )}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No projects found. Create a project first.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          {!canCreate && (
            <p className="text-xs text-destructive -mt-1">
              Add a title or description before creating.
            </p>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canCreate || createMutation.isPending}>
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              )}
              Create Thread
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
