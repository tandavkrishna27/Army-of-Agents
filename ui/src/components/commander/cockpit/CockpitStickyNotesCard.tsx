import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Plus, Save, Trash2 } from "lucide-react";
import type { CockpitNoteItem, CommanderInputRef } from "@armyofagents/shared";
import { userNotesApi } from "../../../api/user-notes";
import { queryKeys } from "../../../lib/queryKeys";
import { setCommanderRefDragData } from "./cockpitReferenceDrag";
import { COCKPIT_DRAGGABLE_ROW_CLASS } from "./cockpitRowStyles";

const noteColorClasses: Record<CockpitNoteItem["color"], string> = {
  yellow: "border-amber-200/70 bg-amber-50 text-amber-950 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100",
  blue: "border-sky-200/70 bg-sky-50 text-sky-950 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-100",
  green: "border-emerald-200/70 bg-emerald-50 text-emerald-950 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-100",
  pink: "border-rose-200/70 bg-rose-50 text-rose-950 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-100",
};

function notePrompt(note: CockpitNoteItem) {
  const title = note.title?.trim();
  const body = note.body.trim();
  if (title && body) return `Use this note as context: ${title} - ${body}`;
  return `Use this note as context: ${title || body}`;
}

function noteRef(note: CockpitNoteItem): CommanderInputRef {
  const body = note.body.trim();
  return {
    v: 1,
    kind: "note",
    id: note.id,
    label: note.title?.trim() || body.slice(0, 80) || "Untitled note",
    detail: body.slice(0, 500),
  };
}

export function CockpitStickyNotesCard({
  companyId,
  items,
  onAsk,
  onReference,
}: {
  companyId: string;
  items: CockpitNoteItem[];
  onAsk?: (text: string) => void;
  onReference?: (ref: CommanderInputRef, suggestedPrompt?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<Record<string, string>>({});

  const invalidateCockpit = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.cockpit(companyId) });

  const createMutation = useMutation({
    mutationFn: (body: string) => userNotesApi.create(companyId, { body }),
    onSuccess: () => {
      setDraft("");
      void invalidateCockpit();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ noteId, body }: { noteId: string; body: string }) =>
      userNotesApi.update(companyId, noteId, { body }),
    onSuccess: (_result, variables) => {
      setEditing((prev) => {
        const next = { ...prev };
        delete next[variables.noteId];
        return next;
      });
      void invalidateCockpit();
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (noteId: string) => userNotesApi.archive(companyId, noteId),
    onSuccess: () => {
      void invalidateCockpit();
    },
  });

  const canCreate = draft.trim().length > 0 && !createMutation.isPending;

  return (
    <div data-testid="cockpit-card-stickyNotes" className="space-y-2">
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (canCreate) createMutation.mutate(draft.trim());
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="New note"
          aria-label="New note"
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-brand"
          maxLength={240}
        />
        <button
          type="submit"
          aria-label="Add note"
          title="Add note"
          disabled={!canCreate}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand text-brand-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="size-3.5" aria-hidden />
        </button>
      </form>

      {items.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((note) => {
            const body = editing[note.id] ?? note.body;
            const hasChanges = body !== note.body;
            const isSaving = updateMutation.isPending && updateMutation.variables?.noteId === note.id;

            return (
              <li
                key={note.id}
                data-testid="cockpit-sticky-note-row"
                draggable
                onDragStart={(event) => {
                  const liveNote = { ...note, body };
                  setCommanderRefDragData(event.dataTransfer, noteRef(liveNote), notePrompt(liveNote));
                }}
                className={`rounded-md border p-2 ${noteColorClasses[note.color]} ${COCKPIT_DRAGGABLE_ROW_CLASS}`}
              >
                {note.title && (
                  <p className="mb-1 truncate text-xs font-semibold">{note.title}</p>
                )}
                <textarea
                  value={body}
                  onChange={(event) =>
                    setEditing((prev) => ({ ...prev, [note.id]: event.target.value }))
                  }
                  aria-label="Note body"
                  rows={Math.min(4, Math.max(2, body.split("\n").length))}
                  className="min-h-12 w-full resize-none rounded border border-transparent bg-transparent text-xs outline-none focus:border-border focus:bg-background/60"
                  maxLength={10_000}
                />
                <div className="mt-1 flex items-center justify-end gap-1">
                  {onAsk && (
                    <button
                      type="button"
                      aria-label="Ask Commander about this note"
                      title="Ask Commander about this note"
                      className="flex h-6 w-6 items-center justify-center rounded text-current opacity-70 hover:bg-background/60 hover:opacity-100"
                      onClick={() => {
                        const liveNote = { ...note, body };
                        const prompt = notePrompt(liveNote);
                        const ref = noteRef(liveNote);
                        if (onReference) onReference(ref, prompt);
                        else onAsk(prompt);
                      }}
                    >
                      <MessageSquare className="size-3" aria-hidden />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="Save note"
                    title="Save note"
                    disabled={!hasChanges || isSaving}
                    className="flex h-6 w-6 items-center justify-center rounded text-current opacity-70 hover:bg-background/60 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                    onClick={() => updateMutation.mutate({ noteId: note.id, body })}
                  >
                    <Save className="size-3" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label="Archive note"
                    title="Archive note"
                    disabled={archiveMutation.isPending}
                    className="flex h-6 w-6 items-center justify-center rounded text-current opacity-70 hover:bg-background/60 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                    onClick={() => archiveMutation.mutate(note.id)}
                  >
                    <Trash2 className="size-3" aria-hidden />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
