import { ChevronDown, ChevronRight, Code2, Eye, FileText, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type ViewMode = "preview" | "code";

interface Props {
  filePath: string;
  fileCount: number;
  treeExpanded: boolean;
  viewMode: ViewMode;
  editing: boolean;
  hasUnsavedChanges: boolean;
  savePending: boolean;
  onToggleTree: () => void;
  onViewMode: (mode: ViewMode) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function SkillFilePathStrip({
  filePath,
  fileCount,
  treeExpanded,
  viewMode,
  editing,
  hasUnsavedChanges,
  savePending,
  onToggleTree,
  onViewMode,
  onSave,
  onCancel,
}: Props) {
  const Chevron = treeExpanded ? ChevronDown : ChevronRight;
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-6">
      {fileCount > 1 ? (
        <button
          type="button"
          aria-label="Toggle file tree"
          onClick={onToggleTree}
          className={cn(
            "-mx-1.5 flex items-center gap-1.5 rounded px-1.5 py-1 text-dim",
            "hover:text-text",
            treeExpanded && "text-brand",
          )}
        >
          <Chevron className="size-3.5" />
          <FileText className="size-3.5" />
          <span className="font-mono text-[11.5px]">{filePath}</span>
          {hasUnsavedChanges && (
            <span aria-hidden className="ml-1 text-amber-500">
              ●
            </span>
          )}
        </button>
      ) : (
        <span className="flex items-center gap-1.5 text-text">
          <FileText className="size-3.5" />
          <span className="font-mono text-[11.5px]">{filePath}</span>
          {hasUnsavedChanges && (
            <span aria-hidden className="ml-1 text-amber-500">
              ●
            </span>
          )}
        </span>
      )}
      <span className="text-[11px] text-dim">
        {hasUnsavedChanges
          ? "· unsaved changes"
          : `· ${fileCount} ${fileCount === 1 ? "file" : "files"} in this skill`}
      </span>

      <div className="flex-1" />

      {editing ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={savePending}
            className="h-6 px-2 text-[11px]"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onSave}
            disabled={savePending}
            className="h-6 gap-1 px-2.5 text-[11px]"
          >
            <Save className="size-3" />
            {savePending ? "Saving…" : "Save"}
          </Button>
        </>
      ) : (
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          <button
            type="button"
            onClick={() => onViewMode("preview")}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 text-[11px]",
              viewMode === "preview" ? "bg-brand/10 text-brand" : "text-dim",
            )}
          >
            <Eye className="size-3" />
            View
          </button>
          <button
            type="button"
            onClick={() => onViewMode("code")}
            className={cn(
              "flex items-center gap-1.5 border-l border-border px-2.5 py-1 text-[11px]",
              viewMode === "code" ? "bg-brand/10 text-brand" : "text-dim",
            )}
          >
            <Code2 className="size-3" />
            Code
          </button>
        </div>
      )}
    </div>
  );
}
