import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Pin, Eye, Pencil, ExternalLink } from "lucide-react";
import {
  COMPANY_BRAIN_EDITABLE_EDGE_KINDS,
  type MemoryItem,
} from "@armyofagents/shared";
import { memoryApi } from "../../../api/memory";
import { queryKeys } from "../../../lib/queryKeys";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { MarkdownEditorView } from "./MarkdownEditorView";
import { MemoryApprovalActions } from "../MemoryApprovalActions";
import { MemoryItemActions } from "../MemoryItemActions";
import { SourceTextDrawer } from "../SourceTextDrawer";
import { MemoryChip } from "../MemoryChip";
import { BacklinksPanel } from "../graph/BacklinksPanel";
import {
  STATUS_TONE,
  LAYER_TONE,
  CATEGORY_TONE,
  LAYER_LABELS,
} from "../../../lib/memoryItemView";

interface MarkdownItemViewerProps {
  companyId: string;
  itemId: string;
}

const EDIT_DEFAULT_STATUSES = new Set(["pending", "draft", "rejected"]);

export function MarkdownItemViewer({ companyId, itemId }: MarkdownItemViewerProps) {
  const { data: item, isLoading, isError } = useQuery({
    queryKey: queryKeys.memory.detail(companyId, itemId),
    queryFn: () => memoryApi.get(companyId, itemId),
    enabled: Boolean(companyId && itemId),
  });

  const backlinksQuery = useQuery({
    queryKey: queryKeys.memory.neighbors(companyId, itemId),
    queryFn: () => memoryApi.neighbors(companyId, itemId, {
      depth: 1,
      kinds: [...COMPANY_BRAIN_EDITABLE_EDGE_KINDS],
    }),
    enabled: Boolean(companyId && itemId),
  });

  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [sourceOpen, setSourceOpen] = useState(false);

  useEffect(() => {
    if (item) {
      setMode(EDIT_DEFAULT_STATUSES.has(item.status as string) ? "edit" : "preview");
    }
  }, [item?.id, item?.status]);

  const updateMutation = useMutation({
    mutationFn: (content: string) =>
      memoryApi.update(companyId, itemId, { content }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memory.detail(companyId, itemId),
      });
    },
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    );
  }

  if (isError || !item) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        Could not load memory item.
      </div>
    );
  }

  // Narrow the API row to the fields we touch here. We deliberately don't widen
  // `layer` to `string` — the shared MemoryItem.layer is already MemoryItemLayer | null,
  // and keeping the union lets the chip render without `as` casts below.
  const i = item as MemoryItem & {
    pinnedToSkill?: boolean;
    folderPath?: string;
    departmentId?: string | null;
    founderPinnedToTop?: boolean;
    importJobId?: string | null;
  };

  const importJobId = i.importJobId ?? null;

  return (
    <div className="h-full flex flex-col relative overflow-hidden">
      <div className="px-6 pt-6 pb-3 border-b border-border">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            {/* chips row */}
            <div className="flex items-center gap-2 text-[10px] mb-2">
              {i.status && (
                <MemoryChip label={i.status} tone={STATUS_TONE[i.status]} />
              )}
              {i.layer && (
                <MemoryChip
                  label={LAYER_LABELS[i.layer]}
                  tone={LAYER_TONE[i.layer]}
                />
              )}
              {i.category && (
                <MemoryChip label={i.category} tone={CATEGORY_TONE[i.category]} />
              )}
              {i.pinnedToSkill && (
                <span
                  className="inline-flex items-center gap-1 text-muted-foreground"
                  title="Pinned to skill"
                >
                  <Pin className="h-3 w-3" />
                </span>
              )}
            </div>
            <h1 className="text-xl font-semibold">{i.title}</h1>
          </div>
          <MemoryItemActions
            companyId={companyId}
            itemId={itemId}
            currentFolderPath={i.folderPath ?? ""}
            currentDepartmentId={i.departmentId ?? null}
            founderPinnedToTop={i.founderPinnedToTop ?? false}
            item={item}
          />
        </div>
        {/* toggle row */}
        <div className="flex items-center gap-2 mt-3">
          <Button
            size="sm"
            variant={mode === "preview" ? "default" : "ghost"}
            onClick={() => setMode("preview")}
            className="h-7 gap-1 text-xs"
          >
            <Eye className="h-3 w-3" />
            Preview
          </Button>
          <Button
            size="sm"
            variant={mode === "edit" ? "default" : "ghost"}
            onClick={() => setMode("edit")}
            className="h-7 gap-1 text-xs"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </Button>
        </div>
        {/* approval row */}
        {i.status === "pending" && (
          <div className="mt-2">
            <MemoryApprovalActions companyId={companyId} itemId={itemId} />
          </div>
        )}
      </div>
      {mode === "preview" ? (
        <div className="flex-1 overflow-auto px-6 py-5 prose prose-sm dark:prose-invert max-w-none prose-headings:font-semibold prose-p:leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{i.content}</ReactMarkdown>
        </div>
      ) : (
        <MarkdownEditorView
          initialContent={i.content}
          onSave={async (content) => { await updateMutation.mutateAsync(content); }}
          saving={updateMutation.isPending}
          saveError={updateMutation.error instanceof Error ? updateMutation.error.message : null}
          statusBanner={
            i.status === "approved"
              ? "Editing — saving will create a new version pending approval"
              : "Editing draft"
          }
        />
      )}

      <BacklinksPanel
        itemId={itemId}
        graph={backlinksQuery.data}
        isLoading={backlinksQuery.isLoading}
      />

      {importJobId && (
        <div className="border-t border-border px-6 py-2 text-xs flex items-center gap-2 bg-card/30">
          <span className="text-muted-foreground">Extracted from a source file</span>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSourceOpen(true)}
            className="h-7 gap-1"
          >
            <ExternalLink className="h-3 w-3" />
            Show source
          </Button>
        </div>
      )}

      {importJobId && (
        <SourceTextDrawer
          open={sourceOpen}
          onOpenChange={setSourceOpen}
          companyId={companyId}
          importJobId={importJobId}
        />
      )}
    </div>
  );
}
