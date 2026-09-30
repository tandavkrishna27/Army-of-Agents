import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { memoryApi } from "../../api/memory";
import { projectsApi } from "../../api/projects";
import { queryKeys } from "../../lib/queryKeys";
import {
  MEMORY_ITEM_CATEGORIES,
  MEMORY_ITEM_LAYERS,
  type MemoryItemCategory,
  type MemoryItemLayer,
  type Project,
} from "@armyofagents/shared";

// ---- constants -------------------------------------------------------

// Source-of-truth enum values come from @armyofagents/shared. We keep
// only the user-facing labels local — adding a category to shared then
// surfaces a TS error here until the label map is updated.
const LAYER_LABELS: Record<MemoryItemLayer, string> = {
  identity: "Identity (always in agent context)",
  domain: "Domain (department-scoped)",
  active_context: "Active context (goal-scoped)",
  working: "Working (task-ephemeral, 7d)",
};

const CATEGORY_LABELS: Record<MemoryItemCategory, string> = {
  decision: "Decision",
  reference: "Reference",
  context: "Context",
  insight: "Insight",
  preference: "Preference",
  procedure: "Procedure",
  policy: "Policy",
};

// ---- props -----------------------------------------------------------

export interface NewMemoryItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  defaultDepartmentId?: string | null;
  defaultFolderPath?: string;
}

// ---- component -------------------------------------------------------

export function NewMemoryItemDialog({
  open,
  onOpenChange,
  companyId,
  defaultDepartmentId,
  defaultFolderPath,
}: NewMemoryItemDialogProps) {
  const qc = useQueryClient();

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [layer, setLayer] = useState<MemoryItemLayer>("domain");
  const [departmentId, setDepartmentId] = useState<string>("none");
  const [category, setCategory] = useState<MemoryItemCategory>("reference");

  // Fetch departments for the department select.
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: open,
  });

  const departments: Project[] = (projects ?? []).filter(
    (p: Project) => p.type === "department",
  );

  // Reset state whenever the dialog opens, seeding from props.
  useEffect(() => {
    if (open) {
      setTitle("");
      setContent("");
      setLayer("domain");
      setDepartmentId(defaultDepartmentId ?? "none");
      setCategory("reference");
    }
  }, [open, defaultDepartmentId]);

  // Clear departmentId when layer changes away from "domain".
  function handleLayerChange(value: MemoryItemLayer) {
    setLayer(value);
    if (value !== "domain") {
      setDepartmentId("none");
    }
  }

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      memoryApi.create(companyId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.memory.list(companyId) });
      qc.invalidateQueries({ queryKey: queryKeys.memory.pending(companyId) });
      onOpenChange(false);
      resetForm();
    },
  });

  function resetForm() {
    setTitle("");
    setContent("");
    setLayer("domain");
    setDepartmentId(defaultDepartmentId ?? "none");
    setCategory("reference");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !content.trim() || createMutation.isPending) return;

    createMutation.mutate({
      title: title.trim(),
      content: content.trim(),
      layer,
      category,
      source: "founder",
      status: "approved",
      departmentId: layer === "domain" && departmentId !== "none" ? departmentId : null,
      ...(defaultFolderPath ? { folderPath: defaultFolderPath } : {}),
    });
  }

  const canSubmit =
    title.trim().length > 0 &&
    content.trim().length > 0 &&
    !createMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to Memory</DialogTitle>
          <DialogDescription className="sr-only">
            Create a new memory item
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          {/* Body padding matches DialogHeader's px-7 inset; DialogFooter
              re-applies its own px-7 + border-t below this block. */}
          <div className="space-y-4 px-7 pb-5">
          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="new-mem-title">Title</Label>
            <Input
              id="new-mem-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Memory item title"
            />
          </div>

          {/* Content */}
          <div className="space-y-1.5">
            <Label htmlFor="new-mem-content">Content</Label>
            <Textarea
              id="new-mem-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Describe the knowledge… (Markdown supported)"
              rows={4}
            />
          </div>

          {/* Layer + Category */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-mem-layer">Layer</Label>
              <Select value={layer} onValueChange={(v) => handleLayerChange(v as MemoryItemLayer)}>
                <SelectTrigger id="new-mem-layer" className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_ITEM_LAYERS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {LAYER_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-mem-category">Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as MemoryItemCategory)}>
                <SelectTrigger id="new-mem-category" className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_ITEM_CATEGORIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {CATEGORY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Department — only when layer === "domain" */}
          {layer === "domain" && (
            <div className="space-y-1.5">
              <Label htmlFor="new-mem-dept">Department</Label>
              <Select value={departmentId} onValueChange={setDepartmentId}>
                <SelectTrigger id="new-mem-dept" className="h-8 text-sm">
                  <SelectValue placeholder="None (company-wide)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (company-wide)</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {createMutation.isError && (
            <p className="text-xs text-red-600 dark:text-red-400" role="alert">
              {createMutation.error instanceof Error
                ? createMutation.error.message
                : "Failed to create memory item. Please try again."}
            </p>
          )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {createMutation.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
