import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { goalsApi } from "../api/goals";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Maximize2, Minimize2 } from "lucide-react";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";
import { GoalFields, type GoalScope } from "./goals/GoalFields";

export function NewGoalDialog() {
  const { newGoalOpen, newGoalDefaults, closeNewGoal } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("planned");
  const [scope, setScope] = useState<GoalScope>({ mode: "company", projectIds: [] });
  const [parentIds, setParentIds] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

  // Seed scope/parents from defaults whenever the dialog opens (e.g. "New
  // sub-goal" pre-selects a parent; a project page pre-scopes the goal).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!newGoalOpen) return;
    setScope(
      (newGoalDefaults.projectIds?.length ?? 0) > 0
        ? { mode: "specific", projectIds: newGoalDefaults.projectIds ?? [] }
        : { mode: "company", projectIds: [] },
    );
    setParentIds(newGoalDefaults.parentId ? [newGoalDefaults.parentId] : []);
  }, [newGoalOpen]);

  const createGoal = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      goalsApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(selectedCompanyId!) });
      reset();
      closeNewGoal();
    },
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(selectedCompanyId, file, "goals/drafts");
    },
  });

  function reset() {
    setTitle("");
    setDescription("");
    setStatus("planned");
    setScope({ mode: "company", projectIds: [] });
    setParentIds([]);
    setExpanded(false);
  }

  const specificButEmpty =
    scope.mode === "specific" && scope.projectIds.length === 0;

  function handleSubmit() {
    if (!selectedCompanyId || !title.trim() || specificButEmpty) return;
    createGoal.mutate({
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      projectIds: scope.projectIds,
      parentIds,
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <Dialog
      open={newGoalOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewGoal();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn(
          "p-0 gap-0 max-h-[85dvh] overflow-y-auto",
          expanded ? "sm:max-w-2xl" : "sm:max-w-lg",
        )}
        onKeyDown={handleKeyDown}
      >
        <DialogTitle className="sr-only">
          {newGoalDefaults.parentId ? "New sub-goal" : "New goal"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Define a goal for the team to achieve
        </DialogDescription>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {selectedCompany && (
              <span className="bg-muted px-1.5 py-0.5 rounded text-xs font-medium">
                {selectedCompany.name.slice(0, 3).toUpperCase()}
              </span>
            )}
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>{newGoalDefaults.parentId ? "New sub-goal" : "New goal"}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
              aria-label={expanded ? "Collapse dialog" : "Expand dialog"}
            >
              {expanded ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => {
                reset();
                closeNewGoal();
              }}
              aria-label="Close new goal dialog"
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        {/* Title */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder="Goal title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                descriptionEditorRef.current?.focus();
              }
            }}
            autoFocus
          />
        </div>

        {/* Description */}
        <div className="px-4 pb-2">
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            placeholder="Add description..."
            bordered={false}
            contentClassName={cn(
              "text-sm text-muted-foreground",
              expanded ? "min-h-[220px]" : "min-h-[120px]",
            )}
            imageUploadHandler={async (file) => {
              const asset = await uploadDescriptionImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
        </div>

        {/* Goal fields (status + scope + parents) */}
        {selectedCompanyId && (
          <div className="px-4 py-3 border-t border-border">
            <GoalFields
              companyId={selectedCompanyId}
              status={status}
              onStatusChange={setStatus}
              scope={scope}
              onScopeChange={setScope}
              parentIds={parentIds}
              onParentsChange={setParentIds}
            />
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end px-4 py-2.5 border-t border-border">
          <Button
            size="sm"
            disabled={!title.trim() || specificButEmpty || createGoal.isPending}
            onClick={handleSubmit}
          >
            {createGoal.isPending
              ? "Creating…"
              : newGoalDefaults.parentId
                ? "Create sub-goal"
                : "Create goal"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
