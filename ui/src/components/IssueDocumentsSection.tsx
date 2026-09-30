import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue, IssueDocument } from "@armyofagents/shared";
import { useLocation } from "@/lib/router";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { useAutosaveIndicator } from "../hooks/useAutosaveIndicator";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MentionOption } from "./MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, ChevronDown, ChevronRight, Copy, Download, FileText, MoreHorizontal, Plus, Trash2, X } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface DraftState {
  body: string;
  title: string;
  baseRevisionId: string | null;
}

interface DocumentConflictState {
  documentId: string;
  serverBody: string;
  serverRevisionId: string;
  localBody: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const AUTOSAVE_DEBOUNCE_MS = 1500;
const DOCUMENT_POLL_INTERVAL = 30_000;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function downloadMarkdown(title: string, body: string) {
  const filename = `${(title || "untitled").replace(/[^a-zA-Z0-9_-]/g, "_")}.md`;
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function copyToClipboard(text: string) {
  void navigator.clipboard.writeText(text);
}

/* ------------------------------------------------------------------ */
/*  AutosaveIndicator                                                  */
/* ------------------------------------------------------------------ */

function AutosaveIndicator({ state }: { state: "idle" | "saving" | "saved" | "error" }) {
  if (state === "idle") return null;
  return (
    <span
      className={cn(
        "text-xs tabular-nums transition-opacity",
        state === "saving" && "text-muted-foreground animate-pulse",
        state === "saved" && "text-emerald-500",
        state === "error" && "text-destructive",
      )}
    >
      {state === "saving" && "Saving..."}
      {state === "saved" && (
        <span className="inline-flex items-center gap-1">
          <Check className="h-3 w-3" /> Saved
        </span>
      )}
      {state === "error" && "Save failed"}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  ConflictBanner                                                     */
/* ------------------------------------------------------------------ */

function ConflictBanner({
  conflict,
  onUseServer,
  onUseLocal,
}: {
  conflict: DocumentConflictState;
  onUseServer: () => void;
  onUseLocal: () => void;
}) {
  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
      <p className="font-medium text-amber-600 dark:text-amber-400">
        This document was updated externally since you started editing.
      </p>
      <p className="mt-1 text-muted-foreground">
        Choose which version to keep. Your local changes will be lost if you use the server version.
      </p>
      <div className="mt-2 flex gap-2">
        <Button variant="outline" size="sm" onClick={onUseServer}>
          Use server version
        </Button>
        <Button variant="outline" size="sm" onClick={onUseLocal}>
          Keep my changes
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  DocumentRow                                                        */
/* ------------------------------------------------------------------ */

function DocumentRow({
  doc,
  isExpanded,
  isEditing,
  onToggle,
  onStartEdit,
  onStopEdit,
  onDelete,
  draft,
  onDraftChange,
  autosaveState,
  conflict,
  onResolveConflictServer,
  onResolveConflictLocal,
  mentions,
  imageUploadHandler,
}: {
  doc: IssueDocument;
  isExpanded: boolean;
  isEditing: boolean;
  onToggle: () => void;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onDelete: () => void;
  draft: DraftState | null;
  onDraftChange: (body: string) => void;
  autosaveState: "idle" | "saving" | "saved" | "error";
  conflict: DocumentConflictState | null;
  onResolveConflictServer: () => void;
  onResolveConflictLocal: () => void;
  mentions?: MentionOption[];
  imageUploadHandler?: (file: File) => Promise<string>;
}) {
  const displayTitle = doc.title || doc.key;

  return (
    <div className="border rounded-lg">
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-muted/50"
        onClick={onToggle}
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">{displayTitle}</span>

        {isEditing && <AutosaveIndicator state={autosaveState} />}

        <span className="text-xs text-muted-foreground shrink-0">
          {relativeTime(doc.updatedAt)}
        </span>

        {/* Actions dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="icon-xs" className="shrink-0">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!isEditing && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onStartEdit();
                }}
              >
                Edit
              </DropdownMenuItem>
            )}
            {isEditing && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onStopEdit();
                }}
              >
                Stop editing
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                copyToClipboard(doc.body);
              }}
            >
              <Copy className="mr-2 h-4 w-4" />
              Copy markdown
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                downloadMarkdown(displayTitle, doc.body);
              }}
            >
              <Download className="mr-2 h-4 w-4" />
              Download
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Body */}
      {isExpanded && (
        <div className="border-t px-3 py-3">
          {conflict && (
            <ConflictBanner
              conflict={conflict}
              onUseServer={onResolveConflictServer}
              onUseLocal={onResolveConflictLocal}
            />
          )}

          {isEditing ? (
            <MarkdownEditor
              value={draft?.body ?? doc.body}
              onChange={onDraftChange}
              placeholder="Write document content..."
              mentions={mentions}
              imageUploadHandler={imageUploadHandler}
              className="min-h-[200px]"
            />
          ) : (
            <div
              className="cursor-pointer"
              onClick={onStartEdit}
            >
              {doc.body.trim() ? (
                <MarkdownBody className="prose-sm">{doc.body}</MarkdownBody>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  Empty document. Click to edit.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  NewDocumentForm                                                    */
/* ------------------------------------------------------------------ */

function NewDocumentForm({
  onSubmit,
  onCancel,
  isCreating,
}: {
  onSubmit: (key: string, title: string) => void;
  onCancel: () => void;
  isCreating: boolean;
}) {
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const keyPattern = /^[a-z0-9][a-z0-9_-]*$/;
  const normalizedKey = key.trim().toLowerCase();
  const keyValid = normalizedKey.length > 0 && keyPattern.test(normalizedKey);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    if (keyValid) onSubmit(normalizedKey, title.trim());
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          placeholder="Document key (e.g. plan)"
          value={key}
          onChange={(e) => setKey(e.target.value.toLowerCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") onCancel();
          }}
          className="h-8 text-sm font-mono"
          disabled={isCreating}
        />
        <Input
          placeholder="Optional title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") onCancel();
          }}
          className="h-8 text-sm"
          disabled={isCreating}
        />
        <Button
          size="sm"
          variant="default"
          disabled={!keyValid || isCreating}
          onClick={handleSubmit}
        >
          Create
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={isCreating}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      {normalizedKey.length > 0 && !keyValid && (
        <p className="text-xs text-destructive">Key must start with a letter or number, using only lowercase letters, numbers, - or _</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  IssueDocumentsSection (main export)                                */
/* ------------------------------------------------------------------ */

interface IssueDocumentsSectionProps {
  issue: Issue;
  canDeleteDocuments?: boolean;
  mentions?: MentionOption[];
  imageUploadHandler?: (file: File) => Promise<string>;
}

export function IssueDocumentsSection({
  issue,
  canDeleteDocuments,
  mentions,
  imageUploadHandler,
}: IssueDocumentsSectionProps) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const autosave = useAutosaveIndicator();

  /* ---- Local state ---- */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Map<string, DraftState>>(new Map());
  const [conflict, setConflict] = useState<DocumentConflictState | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [deleteDocKey, setDeleteDocKey] = useState<string | null>(null);

  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- Query: list documents ---- */
  const documentsQuery = useQuery({
    queryKey: queryKeys.issues.documents(issue.id),
    queryFn: () => issuesApi.listDocuments(issue.id),
    refetchInterval: DOCUMENT_POLL_INTERVAL,
  });

  const documents: IssueDocument[] = documentsQuery.data ?? [];

  /* ---- Mutations ---- */
  const createDocMutation = useMutation({
    mutationFn: (data: { title: string; key: string }) =>
      issuesApi.upsertDocument(issue.id, data.key, {
        title: data.title || null,
        format: "markdown",
        body: "",
        baseRevisionId: null,
      }),
    onSuccess: (newDoc: IssueDocument) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issue.id) });
      setShowNewForm(false);
      setExpandedIds((prev) => new Set([...prev, newDoc.id]));
      setEditingId(newDoc.id);
      setDrafts((prev) => {
        const next = new Map(prev);
        next.set(newDoc.id, {
          body: newDoc.body,
          title: newDoc.title ?? "",
          baseRevisionId: newDoc.latestRevisionId,
        });
        return next;
      });
    },
  });

  const updateDocMutation = useMutation({
    mutationFn: ({
      key,
      body,
      baseRevisionId,
    }: {
      key: string;
      body: string;
      baseRevisionId: string | null;
    }) => issuesApi.upsertDocument(issue.id, key, {
      format: "markdown",
      body,
      baseRevisionId,
    }),
    onSuccess: (updated: IssueDocument) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issue.id) });
      setDrafts((prev) => {
        const next = new Map(prev);
        const existing = next.get(updated.id);
        if (existing) {
          next.set(updated.id, {
            ...existing,
            baseRevisionId: updated.latestRevisionId,
          });
        }
        return next;
      });
    },
    onError: (err, vars) => {
      if (err instanceof ApiError && err.status === 409) {
        // Conflict: the document was updated by someone else.
        const doc = documents.find((d) => d.key === vars.key);
        const draft = doc ? drafts.get(doc.id) : undefined;
        setConflict({
          documentId: doc?.id ?? vars.key,
          serverBody: ((err.body as Record<string, unknown>)?.currentBody as string) ?? "",
          serverRevisionId:
            ((err.body as Record<string, unknown>)?.currentRevisionId as string) ?? "",
          localBody: draft?.body ?? vars.body,
        });
      }
    },
  });

  const deleteDocMutation = useMutation({
    mutationFn: (key: string) => issuesApi.deleteDocument(issue.id, key),
    onSuccess: (_result, key) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issue.id) });
      const doc = documents.find((d) => d.key === key);
      if (doc && editingId === doc.id) {
        setEditingId(null);
      }
      if (doc) {
        setDrafts((prev) => { const next = new Map(prev); next.delete(doc.id); return next; });
        setExpandedIds((prev) => { const next = new Set(prev); next.delete(doc.id); return next; });
      }
    },
  });

  /* ---- Autosave logic ---- */
  const flushAutosave = useCallback(
    (documentId: string) => {
      const draft = drafts.get(documentId);
      if (!draft) return;

      const doc = documents.find((d) => d.id === documentId);
      if (!doc) return;

      // Don't save if body hasn't changed from server.
      if (draft.body === doc.body) {
        autosave.reset();
        return;
      }

      void autosave.runSave(async () => {
        await updateDocMutation.mutateAsync({
          key: doc.key,
          body: draft.body,
          baseRevisionId: draft.baseRevisionId,
        });
      });
    },
    [drafts, documents, autosave, updateDocMutation],
  );

  const scheduleAutosave = useCallback(
    (documentId: string) => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
      }
      autosave.markDirty();
      autosaveTimerRef.current = setTimeout(() => {
        flushAutosave(documentId);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [flushAutosave, autosave],
  );

  // Flush on unmount or when leaving the page.
  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
      }
      if (editingId) {
        flushAutosave(editingId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  // Flush when navigating away.
  useEffect(() => {
    if (editingId) {
      flushAutosave(editingId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  /* ---- Conflict detection on poll ---- */
  useEffect(() => {
    if (!editingId || !documentsQuery.data) return;
    const draft = drafts.get(editingId);
    if (!draft) return;

    const serverDoc = documentsQuery.data.find((d) => d.id === editingId);
    if (!serverDoc) return;

    if (
      serverDoc.latestRevisionId &&
      draft.baseRevisionId &&
      serverDoc.latestRevisionId !== draft.baseRevisionId &&
      serverDoc.body !== draft.body
    ) {
      setConflict({
        documentId: editingId,
        serverBody: serverDoc.body,
        serverRevisionId: serverDoc.latestRevisionId,
        localBody: draft.body,
      });
    }
  }, [documentsQuery.data, editingId, drafts]);

  /* ---- Handlers ---- */
  const handleToggle = useCallback((docId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) {
        next.delete(docId);
      } else {
        next.add(docId);
      }
      return next;
    });
  }, []);

  const handleStartEdit = useCallback(
    (doc: IssueDocument) => {
      // Flush any current editing document first.
      if (editingId && editingId !== doc.id) {
        flushAutosave(editingId);
      }

      setEditingId(doc.id);
      setExpandedIds((prev) => new Set([...prev, doc.id]));
      setDrafts((prev) => {
        const next = new Map(prev);
        if (!next.has(doc.id)) {
          next.set(doc.id, {
            body: doc.body,
            title: doc.title ?? "",
            baseRevisionId: doc.latestRevisionId,
          });
        }
        return next;
      });
    },
    [editingId, flushAutosave],
  );

  const handleStopEdit = useCallback(
    (docId: string) => {
      flushAutosave(docId);
      setEditingId(null);
      setConflict(null);
    },
    [flushAutosave],
  );

  const handleDraftChange = useCallback(
    (docId: string, body: string) => {
      setDrafts((prev) => {
        const next = new Map(prev);
        const existing = next.get(docId);
        next.set(docId, {
          body,
          title: existing?.title ?? "",
          baseRevisionId: existing?.baseRevisionId ?? null,
        });
        return next;
      });
      scheduleAutosave(docId);
    },
    [scheduleAutosave],
  );

  const handleDelete = useCallback((key: string) => {
    setDeleteDocKey(key);
  }, []);

  const handleCreateDocument = useCallback(
    (key: string, title: string) => {
      createDocMutation.mutate({ title, key });
    },
    [createDocMutation],
  );

  const handleResolveConflictServer = useCallback(() => {
    if (!conflict) return;
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(conflict.documentId, {
        body: conflict.serverBody,
        title: next.get(conflict.documentId)?.title ?? "",
        baseRevisionId: conflict.serverRevisionId,
      });
      return next;
    });
    setConflict(null);
    autosave.reset();
  }, [conflict, autosave]);

  const handleResolveConflictLocal = useCallback(() => {
    if (!conflict) return;
    // Update baseRevisionId to the server's so the next save won't conflict.
    setDrafts((prev) => {
      const next = new Map(prev);
      const existing = next.get(conflict.documentId);
      next.set(conflict.documentId, {
        body: existing?.body ?? conflict.localBody,
        title: existing?.title ?? "",
        baseRevisionId: conflict.serverRevisionId,
      });
      return next;
    });
    setConflict(null);
    // Trigger an immediate save with the local content.
    scheduleAutosave(conflict.documentId);
  }, [conflict, scheduleAutosave]);

  /* ---- Render ---- */
  if (documentsQuery.isLoading) {
    return (
      <div className="space-y-2">
        <div className="h-8 bg-muted animate-pulse rounded" />
        <div className="h-8 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Documents
          {documents.length > 0 && (
            <span className="ml-1.5 text-xs font-normal">({documents.length})</span>
          )}
        </h3>
        {!showNewForm && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setShowNewForm(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* New document form */}
      {showNewForm && (
        <NewDocumentForm
          onSubmit={handleCreateDocument}
          onCancel={() => setShowNewForm(false)}
          isCreating={createDocMutation.isPending}
        />
      )}

      {/* Document list */}
      {documents.length === 0 && !showNewForm ? (
        <p className="text-sm text-muted-foreground">
          No documents yet.{" "}
          <button
            type="button"
            className="underline hover:text-foreground"
            onClick={() => setShowNewForm(true)}
          >
            Create one
          </button>
          .
        </p>
      ) : (
        <div className="space-y-2">
          {documents.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              isExpanded={expandedIds.has(doc.id)}
              isEditing={editingId === doc.id}
              onToggle={() => handleToggle(doc.id)}
              onStartEdit={() => handleStartEdit(doc)}
              onStopEdit={() => handleStopEdit(doc.id)}
              onDelete={() => handleDelete(doc.key)}
              draft={drafts.get(doc.id) ?? null}
              onDraftChange={(body) => handleDraftChange(doc.id, body)}
              autosaveState={editingId === doc.id ? autosave.state : "idle"}
              conflict={conflict?.documentId === doc.id ? conflict : null}
              onResolveConflictServer={handleResolveConflictServer}
              onResolveConflictLocal={handleResolveConflictLocal}
              mentions={mentions}
              imageUploadHandler={imageUploadHandler}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleteDocKey !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteDocKey(null);
        }}
        title="Delete this document?"
        description="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          if (!deleteDocKey) return;
          deleteDocMutation.mutate(deleteDocKey);
          setDeleteDocKey(null);
        }}
      />
    </div>
  );
}
