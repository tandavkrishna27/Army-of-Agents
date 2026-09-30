import { useState, useEffect, useRef, useCallback } from "react";
import { Textarea } from "@/components/ui/textarea";

interface NotesSectionProps {
  workspaceId: string;
}

function storageKey(wsId: string) {
  return `aoa:workspace:notes:${wsId}`;
}

export function NotesSection({ workspaceId }: NotesSectionProps) {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(storageKey(workspaceId)) ?? "";
    } catch {
      return "";
    }
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(
    (text: string) => {
      try {
        localStorage.setItem(storageKey(workspaceId), text);
      } catch {
        // localStorage full or unavailable
      }
    },
    [workspaceId],
  );

  // Re-load when workspaceId changes
  useEffect(() => {
    try {
      setValue(localStorage.getItem(storageKey(workspaceId)) ?? "");
    } catch {
      setValue("");
    }
  }, [workspaceId]);

  // Debounced save
  const handleChange = (text: string) => {
    setValue(text);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(text), 500);
  };

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return (
    <div className="px-3" data-testid="notes-section">
      <Textarea
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Add notes about this workspace..."
        className="min-h-[80px] text-sm resize-none"
        data-testid="notes-textarea"
      />
    </div>
  );
}
