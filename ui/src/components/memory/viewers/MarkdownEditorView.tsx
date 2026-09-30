import { useEffect, useState } from "react";
import MDEditor from "@uiw/react-md-editor";
import { Save, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MarkdownEditorViewProps {
  initialContent: string;
  onSave: (content: string) => void | Promise<void>;
  onCancel?: () => void;
  /** Auto-save debounce in ms. 0 disables auto-save. */
  autoSaveMs?: number;
  /** Saving in progress (mutation pending). */
  saving?: boolean;
  /** Save failed message; falsy = no error. */
  saveError?: string | null;
  /** Optional banner above the editor (e.g. "⏳ Editing draft (unpublished)"). */
  statusBanner?: string;
}

export function MarkdownEditorView({
  initialContent,
  onSave,
  onCancel,
  autoSaveMs = 1500,
  saving = false,
  saveError = null,
  statusBanner,
}: MarkdownEditorViewProps) {
  const [value, setValue] = useState(initialContent);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setValue(initialContent);
    setDirty(false);
  }, [initialContent]);

  useEffect(() => {
    if (!dirty || autoSaveMs <= 0) return;
    const id = window.setTimeout(() => {
      void onSave(value);
    }, autoSaveMs);
    return () => window.clearTimeout(id);
  }, [value, dirty, autoSaveMs, onSave]);

  function handleChange(next?: string) {
    const v = next ?? "";
    setValue(v);
    setDirty(v !== initialContent);
  }

  return (
    <div className="h-full flex flex-col">
      {statusBanner && (
        <div className="px-4 py-2 bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 text-xs flex items-center gap-2">
          <AlertCircle className="h-3 w-3" />
          {statusBanner}
        </div>
      )}
      <div className="flex-1 overflow-hidden" data-color-mode="dark">
        <MDEditor
          value={value}
          onChange={handleChange}
          height="100%"
          preview="edit"
          textareaProps={{
            placeholder: "Write your memory item in markdown…",
          }}
        />
      </div>
      <div className="flex items-center gap-2 px-4 py-2 border-t border-border bg-card/40">
        <span
          className={cn(
            "text-[10px]",
            dirty ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
          )}
        >
          {saving
            ? "Saving…"
            : saveError
              ? `Save failed: ${saveError}`
              : dirty
                ? "Unsaved changes (auto-save in 1.5s)"
                : "Saved"}
        </span>
        <span className="flex-1" />
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={() => void onSave(value)}
          className="gap-1"
        >
          <Save className="h-3 w-3" />
          Save
        </Button>
      </div>
    </div>
  );
}
