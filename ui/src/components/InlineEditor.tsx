import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MentionOption } from "./MarkdownEditor";

interface InlineEditorProps {
  value: string;
  onSave: (value: string) => void;
  as?: "h1" | "h2" | "p" | "span";
  className?: string;
  placeholder?: string;
  multiline?: boolean;
  multilineAutoSave?: boolean;
  imageUploadHandler?: (file: File) => Promise<string>;
  mentions?: MentionOption[];
  /** Company ID to enable skill `/`-autocomplete inside the markdown editor. */
  companyId?: string | null;
}

/** Shared padding so display and edit modes occupy the exact same box. */
const pad = "px-1 -mx-1";

export function InlineEditor({
  value,
  onSave,
  as: Tag = "span",
  className,
  placeholder = "Click to edit...",
  multiline = false,
  multilineAutoSave = false,
  imageUploadHandler,
  mentions,
  companyId,
}: InlineEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const autoSize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
      if (inputRef.current instanceof HTMLTextAreaElement) {
        autoSize(inputRef.current);
      }
    }
  }, [editing, autoSize]);

  function commit() {
    const trimmed = draft.trim();
    if ((multiline || trimmed) && trimmed !== value) {
      onSave(trimmed);
    } else {
      setDraft(value);
    }
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") {
      setDraft(value);
      setEditing(false);
    }
  }

  if (editing) {
    if (multiline) {
      return (
        <div className={cn("space-y-2", pad)} onKeyDown={handleKeyDown}>
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            placeholder={placeholder}
            contentClassName={className}
            imageUploadHandler={imageUploadHandler}
            mentions={mentions}
            companyId={companyId}
            onSubmit={commit}
            onBlur={multilineAutoSave ? commit : undefined}
          />
          {multilineAutoSave ? (
            <div className="flex items-center justify-end text-[11px] text-muted-foreground">
              Saves on blur
            </div>
          ) : (
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDraft(value);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={commit}>
                Save
              </Button>
            </div>
          )}
        </div>
      );
    }

    return (
      <textarea
        ref={inputRef}
        value={draft}
        rows={1}
        onChange={(e) => {
          setDraft(e.target.value);
          autoSize(e.target);
        }}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-full bg-transparent rounded outline-none resize-none overflow-hidden",
          pad,
          className
        )}
      />
    );
  }

  // Use div instead of Tag when rendering markdown to avoid invalid nesting
  // (e.g. <p> cannot contain the <div>/<p> elements that markdown produces)
  const DisplayTag = value && multiline ? "div" : Tag;

  return (
    <DisplayTag
      className={cn(
        "cursor-pointer rounded hover:bg-accent/50 transition-colors",
        pad,
        !value && "text-muted-foreground italic",
        className
      )}
      onClick={() => setEditing(true)}
    >
      {value && multiline ? (
        <MarkdownBody>{value}</MarkdownBody>
      ) : (
        value || placeholder
      )}
    </DisplayTag>
  );
}
