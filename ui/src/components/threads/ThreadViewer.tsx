import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  CheckSquare,
  ClipboardList,
  Compass,
  Database,
  ExternalLink,
  FileBox,
  FileText,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  LayoutGrid,
  Link as LinkIcon,
  Map as MapIcon,
  MessageSquare,
  Network,
  Package,
  PanelRightOpen,
} from "lucide-react";
import {
  MEMORY_ITEM_CATEGORIES,
  MEMORY_ITEM_LAYERS,
  type ArtifactWithVersions,
  type Goal,
  type Issue,
  type MemoryFolderRecord,
  type MemoryItemCategory,
  type MemoryItemLayer,
  type Project,
} from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import { IssueProperties } from "@/components/IssueProperties";
import { TaskDetail } from "@/components/TaskDetail";
import { TaskOutputViewer } from "./TaskOutputViewer";
import { BrowserViewer } from "@/components/viewers/BrowserViewer";
import { SharedContentViewer } from "@/components/viewers/SharedContentViewer";
import { ViewerTabs, type ViewerTabModel } from "@/components/viewers/ViewerTabs";
import {
  assetUrlForArtifactVersion,
  contentTypeForArtifactVersion,
  filenameForArtifactVersion,
} from "@/components/viewers/artifact-version-viewer";
import { resolveViewer } from "@/components/viewers/viewer-registry";
import { DiscussionRefTabBody, OutputRefTabBody } from "@/components/viewers/refBodies";
import { ApprovalDetailCore } from "@/components/approval/ApprovalDetailCore";
import { cn } from "@/lib/utils";
import { artifactsApi } from "../../api/artifacts";
import { goalsApi } from "../../api/goals";
import type { IssueContextBundle } from "../../api/issues";
import { issuesApi } from "../../api/issues";
import { memoryApi } from "../../api/memory";
import { memoryFoldersApi } from "../../api/memoryFolders";
import { projectsApi } from "../../api/projects";
import type {
  DiscussionDetail,
  DiscussionEntryAttachment,
  UpdateScopeItemRequest,
} from "../../api/discussions";
import {
  OPEN_TAB_KEY,
  browserTab,
  createGlobalMapTab,
  createOpenTab,
  createThreadMapTab,
  extractUrlsFromThread,
  artifactRefTab,
  memoryTab,
  scopeItemToTab,
  scopeArtifactToTab,
  taskTab,
  threadAttachmentToTab,
  type ThreadViewerApprovalPayload,
  type ThreadViewerArtifactRefPayload,
  type ThreadViewerAttachmentPayload,
  type ThreadViewerBrowserPayload,
  type ThreadViewerDiscussionPayload,
  type ThreadViewerMapPayload,
  type ThreadViewerMemoryPayload,
  type ThreadViewerOutputRefPayload,
  type ThreadViewerScopeItem,
  type ThreadViewerScopePayload,
  type ThreadViewerTab,
  type ThreadViewerTabKind,
  type ThreadViewerTaskPayload,
  type ThreadViewerTaskOutputPayload,
} from "./threadViewerModel";

interface ThreadViewerProps {
  thread: DiscussionDetail;
  tabs: ThreadViewerTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onOpenTab: (tab: ThreadViewerTab) => void;
  onOpenScopePanel: () => void;
  onUpdateScopeItem?: (
    scopeVersionId: string,
    itemId: string,
    patch: UpdateScopeItemRequest,
  ) => Promise<void> | void;
  onCreateScopeOutputItem?: (
    scopeVersionId: string,
    itemId: string,
    options?: CreateScopeOutputItemOptions,
  ) => Promise<void> | void;
  onReviewScopeItem?: (
    scopeVersionId: string,
    itemId: string,
    status: "draft" | "accepted" | "rejected",
  ) => Promise<void> | void;
  onToggleCollapse?: () => void;
  companyId?: string;
  scopeItems?: ThreadViewerScopeItem[];
}

type CreateScopeOutputItemOptions = {
  memoryStatus?: "approved" | "pending";
};

const ICON_FOR_KIND: Record<ThreadViewerTabKind, typeof LayoutGrid> = {
  open: LayoutGrid,
  scope_item: Boxes,
  task: ClipboardList,
  task_output: FileBox,
  memory: Database,
  artifact_ref: FileText,
  asset: ImageIcon,
  artifact: FileText,
  browser: Globe,
  map: Network,
  discussion: MessageSquare,
  approval: CheckSquare,
  output_ref: Package,
};

const MEMORY_CATEGORY_LABELS: Record<MemoryItemCategory, string> = {
  decision: "Decision",
  reference: "Reference",
  context: "Context",
  insight: "Insight",
  preference: "Preference",
  procedure: "Procedure",
  policy: "Policy",
};

const MEMORY_LAYER_LABELS: Record<MemoryItemLayer, string> = {
  identity: "Identity",
  domain: "Domain",
  active_context: "Active context",
  working: "Working",
};

export function ThreadViewer({
  thread,
  tabs,
  activeKey,
  onActivate,
  onClose,
  onOpenTab,
  onOpenScopePanel,
  onUpdateScopeItem,
  onCreateScopeOutputItem,
  onReviewScopeItem,
  onToggleCollapse,
  companyId,
  scopeItems,
}: ThreadViewerProps) {
  const activeTab = activeKey ? tabs.find((tab) => tab.key === activeKey) ?? null : null;
  const defaultScopeItems = useMemo(
    () => thread.entries.flatMap((entry) => entry.extractedItems),
    [thread.entries],
  );
  const viewerScopeItems = scopeItems ?? defaultScopeItems;
  const viewerTabs: ViewerTabModel[] = tabs.map((tab) => ({
    id: tab.key,
    kind: tab.kind,
    title: tab.label,
    closeable: tab.closeable,
    icon: ICON_FOR_KIND[tab.kind],
  }));

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="thread-viewer">
      <ViewerTabs
        tabs={viewerTabs}
        activeKey={activeTab ? { id: activeTab.key, kind: activeTab.kind } : null}
        onActivate={(tab) => onActivate(tab.id)}
        onClose={(tab) => onClose(tab.id)}
        onAdd={() => onOpenTab(createOpenTab())}
        addLabel="Open viewer tab"
        onToggleCollapse={onToggleCollapse}
        tabListLabel="Open thread viewer tabs"
        headerTestId="thread-viewer-header"
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab ? (
          <ThreadViewerBody
            thread={thread}
            tab={activeTab}
            companyId={companyId}
            scopeItems={viewerScopeItems}
            onOpenTab={onOpenTab}
            onOpenScopePanel={onOpenScopePanel}
            onUpdateScopeItem={onUpdateScopeItem}
            onCreateScopeOutputItem={onCreateScopeOutputItem}
            onReviewScopeItem={onReviewScopeItem}
          />
        ) : (
          <ThreadViewerEmpty onOpen={() => onOpenTab(createOpenTab())} />
        )}
      </div>
    </div>
  );
}

interface ThreadCollapsedTabStripProps {
  tabs: ThreadViewerTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onExpand: () => void;
}

export function ThreadCollapsedTabStrip({
  tabs,
  activeKey,
  onActivate,
  onExpand,
}: ThreadCollapsedTabStripProps) {
  return (
    <aside
      className="flex h-full w-[46px] shrink-0 flex-col items-center bg-card"
      data-testid="thread-viewer-collapsed-strip"
    >
      <div className="flex h-[42px] w-full shrink-0 items-center justify-center border-b border-border">
        <button
          type="button"
          title="Open viewer"
          aria-label="Open viewer"
          onClick={onExpand}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <PanelRightOpen className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center gap-1 py-2">
        {tabs.map((tab) => {
          const Icon = ICON_FOR_KIND[tab.kind];
          const active = tab.key === activeKey;
          return (
            <button
              key={tab.key}
              type="button"
              title={tab.label}
              aria-label={tab.label}
              data-tab-id={tab.key}
              data-tab-kind={tab.kind}
              data-active={active}
              onClick={() => {
                onActivate(tab.key);
                onExpand();
              }}
              className={cn(
                "relative flex size-10 items-center justify-center rounded-md",
                active
                  ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
                  : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {active && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute -left-[3px] top-1/2 h-[18px] w-[3px] -translate-y-1/2 rounded-r bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
                />
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function ThreadViewerEmpty({ onOpen }: { onOpen: () => void }) {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center p-6"
      data-testid="thread-viewer-empty"
    >
      <div className="max-w-xs text-center">
        <Compass className="mx-auto mb-3 h-5 w-5 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium text-foreground">No viewer tab open</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Open files, links, scope items, maps, or a browser from this thread.
        </p>
        <Button type="button" variant="outline" size="sm" className="mt-4 h-8 text-xs" onClick={onOpen}>
          Open
        </Button>
      </div>
    </div>
  );
}

function ThreadViewerBody({
  thread,
  tab,
  companyId,
  scopeItems,
  onOpenTab,
  onOpenScopePanel,
  onUpdateScopeItem,
  onCreateScopeOutputItem,
  onReviewScopeItem,
}: {
  thread: DiscussionDetail;
  tab: ThreadViewerTab;
  companyId?: string;
  scopeItems: ThreadViewerScopeItem[];
  onOpenTab: (tab: ThreadViewerTab) => void;
  onOpenScopePanel: () => void;
  onUpdateScopeItem?: (
    scopeVersionId: string,
    itemId: string,
    patch: UpdateScopeItemRequest,
  ) => Promise<void> | void;
  onCreateScopeOutputItem?: (
    scopeVersionId: string,
    itemId: string,
    options?: CreateScopeOutputItemOptions,
  ) => Promise<void> | void;
  onReviewScopeItem?: (
    scopeVersionId: string,
    itemId: string,
    status: "draft" | "accepted" | "rejected",
  ) => Promise<void> | void;
}) {
  if (tab.key === OPEN_TAB_KEY || tab.kind === "open") {
    return (
      <ThreadOpenViewer
        thread={thread}
        companyId={companyId}
        scopeItems={scopeItems}
        onOpenTab={onOpenTab}
        onOpenScopePanel={onOpenScopePanel}
      />
    );
  }

  if (tab.kind === "scope_item") {
    const payload = tab.payload as ThreadViewerScopePayload | undefined;
    return payload ? (
      <ScopeItemViewer
        item={payload.item}
        scopeItems={scopeItems}
        thread={thread}
        companyId={companyId}
        onOpenTab={onOpenTab}
        onOpenScopePanel={onOpenScopePanel}
        onUpdateScopeItem={onUpdateScopeItem}
        onCreateScopeOutputItem={onCreateScopeOutputItem}
        onReviewScopeItem={onReviewScopeItem}
      />
    ) : null;
  }

  if (tab.kind === "task") {
    const payload = tab.payload as ThreadViewerTaskPayload | undefined;
    return payload ? (
      <TaskDetail
        issueId={payload.issueId}
        active
        onOpenScopeHandoffItem={(item) => {
          const metadata = payloadRecord(item.metadata);
          const label = item.label || item.itemType.replaceAll("_", " ");
          if (item.itemType === "artifact" && item.sourceId) {
            const artifactVersionId = payloadString(metadata.artifactVersionId);
            const scopeItemId = payloadString(metadata.scopeItemId);
            onOpenTab(artifactRefTab(item.sourceId, label, artifactVersionId, scopeItemId ?? undefined));
            return;
          }
          if (item.itemType === "asset" && item.sourceId) {
            onOpenTab(threadAttachmentToTab(contextBundleAssetToAttachment(item), payloadString(metadata.entryId) ?? undefined));
            return;
          }
          const url = payloadString(metadata.url);
          if (item.itemType === "url" && url) {
            onOpenTab(browserTab(url, label));
          }
        }}
      />
    ) : null;
  }

  if (tab.kind === "task_output") {
    const payload = tab.payload as ThreadViewerTaskOutputPayload | undefined;
    return payload ? <TaskOutputViewer issueId={payload.issueId} embedded /> : null;
  }

  if (tab.kind === "memory") {
    const payload = tab.payload as ThreadViewerMemoryPayload | undefined;
    return payload ? <MemoryLinkedViewer payload={payload} /> : null;
  }

  if (tab.kind === "artifact_ref") {
    const payload = tab.payload as ThreadViewerArtifactRefPayload | undefined;
    return payload ? (
      <ArtifactAttachmentViewer
        artifactId={payload.artifactId}
        artifactVersionId={payload.artifactVersionId}
        scopeItemId={payload.scopeItemId}
      />
    ) : null;
  }

  if (tab.kind === "asset") {
    const payload = tab.payload as ThreadViewerAttachmentPayload | undefined;
    return payload ? <AssetAttachmentViewer attachment={payload.attachment} /> : null;
  }

  if (tab.kind === "artifact") {
    const payload = tab.payload as ThreadViewerAttachmentPayload | undefined;
    return payload ? <ArtifactAttachmentViewer artifactId={payload.attachment.artifactId} /> : null;
  }

  if (tab.kind === "browser") {
    const payload = tab.payload as ThreadViewerBrowserPayload | undefined;
    return <BrowserViewer key={tab.key} initialUrl={payload?.url ?? "about:blank"} />;
  }

  // ── Viewer Upgrade Phase 7B — navigational bodies (REUSE shared self-fetching
  // bodies; no rebuild of task/memory/artifact/asset). companyId prefers the live
  // ThreadViewerBody prop, falling back to the value carried on the tab payload. ──
  if (tab.kind === "discussion") {
    const payload = tab.payload as ThreadViewerDiscussionPayload | undefined;
    if (!payload) return null;
    return (
      <DiscussionRefTabBody
        key={tab.key}
        companyId={companyId ?? payload.companyId}
        refId={payload.discussionId}
        fallbackTitle={payload.title}
      />
    );
  }

  if (tab.kind === "approval") {
    const payload = tab.payload as ThreadViewerApprovalPayload | undefined;
    return payload ? <ApprovalDetailCore key={tab.key} approvalId={payload.approvalId} embedded /> : null;
  }

  if (tab.kind === "output_ref") {
    const payload = tab.payload as ThreadViewerOutputRefPayload | undefined;
    if (!payload) return null;
    return (
      <OutputRefTabBody
        key={tab.key}
        companyId={companyId ?? payload.companyId}
        refId={payload.outputId}
        viewerKind={payload.viewerKind ?? undefined}
      />
    );
  }

  if (tab.kind === "map") {
    const payload = tab.payload as ThreadViewerMapPayload | undefined;
    return <MapPlaceholder payload={payload} thread={thread} />;
  }

  return null;
}

function ThreadOpenViewer({
  thread,
  companyId,
  scopeItems,
  onOpenTab,
  onOpenScopePanel,
}: {
  thread: DiscussionDetail;
  companyId?: string;
  scopeItems: ThreadViewerScopeItem[];
  onOpenTab: (tab: ThreadViewerTab) => void;
  onOpenScopePanel: () => void;
}) {
  const urls = useMemo(() => extractUrlsFromThread(thread), [thread]);
  const attachments = useMemo(
    () =>
      thread.entries.flatMap((entry) =>
        (entry.attachments ?? []).map((attachment) => ({ attachment, entryId: entry.id })),
      ),
    [thread.entries],
  );
  const scopeArtifactItems = useMemo(
    () => scopeItems.filter((item) => Boolean(item.artifactId)),
    [scopeItems],
  );
  const fileArtifactCount = attachments.length + scopeArtifactItems.length;
  const openScopeItem = useCallback((item: ThreadViewerScopeItem) => {
    if (item.resultIssueId) {
      onOpenTab(taskTab(item.resultIssueId, item.title, item.id));
      return;
    }
    if (item.resultMemoryId) {
      onOpenTab(memoryTab(companyId ?? "", item.resultMemoryId, item.title, item.id));
      return;
    }
    if (item.artifactId) {
      onOpenTab(artifactRefTab(item.artifactId, item.title, item.artifactVersionId, item.id));
      return;
    }
    onOpenTab(scopeItemToTab(item));
  }, [companyId, onOpenTab]);

  return (
    <div className="h-full min-h-0 overflow-auto p-3" data-testid="thread-open-viewer">
      <div className="space-y-3">
        <OpenSection title="Map" icon={MapIcon}>
          <div className="grid grid-cols-2 gap-2">
            <OpenButton
              title="Thread map"
              subtitle="Relationships for this thread"
              icon={Network}
              onClick={() => onOpenTab(createThreadMapTab(thread.id))}
            />
            <OpenButton
              title="Global map"
              subtitle="All discussions placeholder"
              icon={MapIcon}
              onClick={() => onOpenTab(createGlobalMapTab())}
            />
          </div>
        </OpenSection>

        <OpenSection title="Browser" icon={Globe}>
          <OpenButton
            title="New browser"
            subtitle="Open a URL in this viewer"
            icon={Globe}
            onClick={() => onOpenTab(browserTab("about:blank", "Browser"))}
          />
        </OpenSection>

        <OpenSection title="Scope items" icon={Boxes} trailing={scopeItems.length}>
          <div className="space-y-1">
            {scopeItems.slice(0, 8).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => openScopeItem(item)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="shrink-0 capitalize">{item.status}</span>
              </button>
            ))}
            {scopeItems.length === 0 && <EmptyLine>No scope items yet.</EmptyLine>}
            <button
              type="button"
              onClick={onOpenScopePanel}
              className="mt-1 inline-flex items-center gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              Open Scope panel <ExternalLink className="h-3 w-3" />
            </button>
          </div>
        </OpenSection>

        <OpenSection title="Files & artifacts" icon={FolderOpen} trailing={fileArtifactCount}>
          <div className="space-y-1">
            {scopeArtifactItems.map((item) => (
              <button
                key={`scope-artifact-${item.id}`}
                type="button"
                onClick={() => {
                  const tab = scopeArtifactToTab(item);
                  if (tab) onOpenTab(tab);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px]">
                  Scope
                </span>
              </button>
            ))}
            {attachments.map(({ attachment, entryId }) => (
              <button
                key={attachment.id}
                type="button"
                onClick={() => onOpenTab(threadAttachmentToTab(attachment, entryId))}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {attachment.artifactTitle || attachment.assetOriginalFilename || "Attached file"}
                </span>
              </button>
            ))}
            {fileArtifactCount === 0 && <EmptyLine>No files attached yet.</EmptyLine>}
          </div>
        </OpenSection>

        <OpenSection title="Links" icon={LinkIcon} trailing={urls.length}>
          <div className="space-y-1">
            {urls.map((url) => (
              <button
                key={url}
                type="button"
                onClick={() => onOpenTab(browserTab(url))}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <LinkIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{url}</span>
              </button>
            ))}
            {urls.length === 0 && <EmptyLine>No links detected in this thread.</EmptyLine>}
          </div>
        </OpenSection>
      </div>
    </div>
  );
}

function OpenSection({
  title,
  icon: Icon,
  trailing,
  children,
}: {
  title: string;
  icon: typeof LayoutGrid;
  trailing?: number;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border/70 bg-card/50 p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <h3 className="min-w-0 flex-1 text-xs font-semibold">{title}</h3>
        {trailing !== undefined && (
          <span className="text-[10px] tabular-nums text-muted-foreground">{trailing}</span>
        )}
      </div>
      {children}
    </section>
  );
}

function OpenButton({
  title,
  subtitle,
  icon: Icon,
  onClick,
}: {
  title: string;
  subtitle: string;
  icon: typeof LayoutGrid;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-background px-2 py-2 text-left transition-colors hover:bg-muted/50"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium">{title}</span>
        <span className="block truncate text-[10px] text-muted-foreground">{subtitle}</span>
      </span>
    </button>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-xs text-muted-foreground">{children}</p>;
}

function ScopeItemViewer({
  item,
  scopeItems,
  thread,
  companyId,
  onOpenTab,
  onOpenScopePanel,
  onUpdateScopeItem,
  onCreateScopeOutputItem,
  onReviewScopeItem,
}: {
  item: ThreadViewerScopeItem;
  scopeItems: ThreadViewerScopeItem[];
  thread: DiscussionDetail;
  companyId?: string;
  onOpenTab: (tab: ThreadViewerTab) => void;
  onOpenScopePanel: () => void;
  onUpdateScopeItem?: (
    scopeVersionId: string,
    itemId: string,
    patch: UpdateScopeItemRequest,
  ) => Promise<void> | void;
  onCreateScopeOutputItem?: (
    scopeVersionId: string,
    itemId: string,
    options?: CreateScopeOutputItemOptions,
  ) => Promise<void> | void;
  onReviewScopeItem?: (
    scopeVersionId: string,
    itemId: string,
    status: "draft" | "accepted" | "rejected",
  ) => Promise<void> | void;
}) {
  const payload = (
    "payload" in item && item.payload && typeof item.payload === "object"
      ? item.payload
      : {}
  ) as Record<string, unknown>;
  const assetId = typeof payload.assetId === "string" ? payload.assetId : null;
  const contentType = typeof payload.contentType === "string" ? payload.contentType : null;
  const filename = typeof payload.filename === "string" ? payload.filename : null;
  const role = typeof payload.role === "string" ? payload.role : null;
  const sourceEntryIds = Array.isArray(item.sourceEntryIds)
    ? item.sourceEntryIds.filter((value): value is string => typeof value === "string")
    : [];
  const kind = item.kind ?? item.type.replaceAll(" ", "_");

  if (kind === "task_proposal" && !item.resultIssueId) {
    return (
        <DraftTaskScopeItemViewer
        item={item}
        scopeItems={scopeItems}
        thread={thread}
        companyId={companyId}
        onOpenTab={onOpenTab}
        onOpenScopePanel={onOpenScopePanel}
        onUpdateScopeItem={onUpdateScopeItem}
        onCreateScopeOutputItem={onCreateScopeOutputItem}
        onReviewScopeItem={onReviewScopeItem}
      />
    );
  }

  if (kind === "memory_candidate" && !item.resultMemoryId) {
    return (
      <DraftMemoryScopeItemViewer
        item={item}
        companyId={companyId}
        onOpenScopePanel={onOpenScopePanel}
        onUpdateScopeItem={onUpdateScopeItem}
        onCreateScopeOutputItem={onCreateScopeOutputItem}
        onReviewScopeItem={onReviewScopeItem}
      />
    );
  }

  return (
    <div className="h-full min-h-0 overflow-auto p-4" data-testid="thread-scope-item-viewer">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {item.type}
          </div>
          <h3 className="mt-1 text-sm font-semibold leading-snug">{item.title}</h3>
        </div>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] capitalize text-muted-foreground">
          {item.status}
        </span>
      </div>
      {item.description && (
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{item.description}</p>
      )}
      <dl className="space-y-2 text-xs">
        <MetaRow label="Priority" value={item.suggestedPriority ?? item.priority ?? null} />
        <MetaRow label="Layer" value={item.suggestedLayer ?? item.layer ?? null} />
        <MetaRow label="Assignee" value={item.suggestedAssigneeId ?? null} />
        <MetaRow label="Department" value={item.suggestedDepartmentId ?? null} />
        <MetaRow label="Role" value={role} />
        <MetaRow label="Asset" value={assetId} />
        <MetaRow label="Filename" value={filename} />
        <MetaRow label="Type" value={contentType} />
      </dl>
      {sourceEntryIds.length > 0 && (
        <div className="mt-4 text-xs">
          <h4 className="font-semibold text-foreground">Sources</h4>
          <ul className="mt-1.5 space-y-1 text-muted-foreground">
            {sourceEntryIds.map((entryId) => (
              <li key={entryId}>{entryId}</li>
            ))}
          </ul>
        </div>
      )}
      <Button type="button" variant="outline" size="sm" className="mt-4 h-8 text-xs" onClick={onOpenScopePanel}>
        Open Scope panel
      </Button>
    </div>
  );
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function payloadString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function payloadStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function payloadNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactText(value: string, max = 96): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function entryDisplayName(entry: DiscussionDetail["entries"][number]): string {
  if (entry.authorAgentName) return entry.authorAgentName;
  if (entry.inputType === "agent") return "Agent";
  return "You";
}

function sourceMessageLabel(
  thread: DiscussionDetail,
  entryId: string,
): { title: string; subtitle: string } {
  const entry = thread.entries.find((candidate) => candidate.id === entryId);
  if (!entry) return { title: "Source message", subtitle: entryId };
  const index = thread.entries.findIndex((candidate) => candidate.id === entryId);
  return {
    title: `Message ${index + 1} - ${entryDisplayName(entry)}`,
    subtitle: compactText(entry.rawContent),
  };
}

function isMemoryCategory(value: string | null): value is MemoryItemCategory {
  return Boolean(value && (MEMORY_ITEM_CATEGORIES as readonly string[]).includes(value));
}

function isMemoryLayer(value: string | null): value is MemoryItemLayer {
  return Boolean(value && (MEMORY_ITEM_LAYERS as readonly string[]).includes(value));
}

function noneToNull(value: string): string | null {
  return value === "none" ? null : value;
}

function labelById<T extends { id: string }>(
  items: T[] | undefined,
  id: string | null | undefined,
  getLabel: (item: T) => string,
) {
  if (!id) return null;
  return items?.find((item) => item.id === id)
    ? getLabel(items.find((item) => item.id === id) as T)
    : id;
}

function contextBundleAssetToAttachment(
  item: IssueContextBundle["items"][number],
): DiscussionEntryAttachment {
  const metadata = payloadRecord(item.metadata);
  return {
    id: item.id,
    assetId: item.sourceId ?? null,
    artifactId: null,
    artifactType: null,
    artifactTitle: null,
    assetContentType: payloadString(metadata.contentType),
    assetOriginalFilename: item.label ?? payloadString(metadata.filename),
    assetByteSize: typeof metadata.byteSize === "number" ? metadata.byteSize : null,
  };
}

type ScopeHandoffRefType =
  | "discussion_entry"
  | "artifact"
  | "asset"
  | "url"
  | "text";

interface ScopeHandoffRef {
  type: ScopeHandoffRefType;
  id?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

interface ScopeHandoffOption {
  key: string;
  ref: ScopeHandoffRef;
  title: string;
  subtitle: string;
}

function handoffRefKey(ref: ScopeHandoffRef): string {
  const id = ref.id ?? (typeof ref.metadata?.url === "string" ? ref.metadata.url : ref.label ?? "");
  return `${ref.type}:${id}`;
}

function handoffRefsFromPayload(value: unknown): ScopeHandoffRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs = value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const type = payloadString(record.type) as ScopeHandoffRefType | null;
    if (!type || !["discussion_entry", "artifact", "asset", "url", "text"].includes(type)) return [];
    const metadata =
      record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
        ? (record.metadata as Record<string, unknown>)
        : undefined;
    return [
      {
        type,
        id: payloadString(record.id) ?? undefined,
        label: payloadString(record.label) ?? undefined,
        metadata,
      },
    ];
  });
  return refs;
}

function addHandoffOption(
  options: ScopeHandoffOption[],
  ref: ScopeHandoffRef,
  title: string,
  subtitle: string,
) {
  const key = handoffRefKey(ref);
  if (options.some((option) => option.key === key)) return;
  options.push({ key, ref, title, subtitle });
}

function buildScopeHandoffOptions(
  item: ThreadViewerScopeItem,
  scopeItems: ThreadViewerScopeItem[],
  thread: DiscussionDetail,
): ScopeHandoffOption[] {
  const options: ScopeHandoffOption[] = [];
  const sourceEntryIds = Array.isArray(item.sourceEntryIds)
    ? item.sourceEntryIds.filter((value): value is string => typeof value === "string")
    : [];
  for (const entryId of sourceEntryIds) {
    const sourceLabel = sourceMessageLabel(thread, entryId);
    addHandoffOption(
      options,
      {
        type: "discussion_entry",
        id: entryId,
        label: sourceLabel.title,
        metadata: { scopeItemId: item.id },
      },
      sourceLabel.title,
      sourceLabel.subtitle,
    );
  }

  const relatedItems = scopeItems.filter(
    (candidate) =>
      candidate.id !== item.id &&
      (!item.scopeVersionId || candidate.scopeVersionId === item.scopeVersionId),
  );
  for (const candidate of relatedItems) {
    const payload = payloadRecord(candidate.payload);
    const kind = candidate.kind ?? candidate.type.replaceAll(" ", "_");
    const contentType = payloadString(payload.contentType);
    const artifactType = payloadString(payload.artifactType);
    const assetId = payloadString(payload.assetId);
    const url = payloadString(payload.url);

    if (kind === "artifact_link" && candidate.artifactId) {
      if (payload.storageKind === "asset" && assetId) {
        addHandoffOption(
          options,
          {
            type: "asset",
            id: assetId,
            label: payloadString(payload.filename) ?? candidate.title,
            metadata: {
              contentType: contentType ?? undefined,
              filename: payloadString(payload.filename) ?? undefined,
              artifactId: candidate.artifactId,
              artifactVersionId: candidate.artifactVersionId ?? undefined,
              scopeItemId: candidate.id,
            },
          },
          payloadString(payload.filename) ?? candidate.title,
          contentType ?? "Uploaded artifact file",
        );
        continue;
      }

      addHandoffOption(
        options,
        {
          type: "artifact",
          id: candidate.artifactId,
          label: candidate.title,
          metadata: {
            artifactVersionId: candidate.artifactVersionId ?? undefined,
            artifactType: artifactType ?? contentType ?? undefined,
            scopeItemId: candidate.id,
          },
        },
        candidate.title,
        artifactType ?? contentType ?? "Artifact linked by this scope",
      );
      continue;
    }

    if (kind !== "source_signal") continue;

    if (assetId) {
      addHandoffOption(
        options,
        {
          type: "asset",
          id: assetId,
          label: candidate.title,
          metadata: { contentType: contentType ?? undefined, scopeItemId: candidate.id },
        },
        candidate.title,
        contentType ?? "Uploaded source file",
      );
      continue;
    }

    if (url) {
      addHandoffOption(
        options,
        {
          type: "url",
          label: candidate.title,
          metadata: { url, scopeItemId: candidate.id },
        },
        candidate.title,
        url,
      );
      continue;
    }

    if (candidate.description) {
      addHandoffOption(
        options,
        {
          type: "text",
          label: candidate.title,
          metadata: { body: candidate.description, scopeItemId: candidate.id },
        },
        candidate.title,
        "Text signal from this scope",
      );
    }
  }

  return options;
}

function makeDraftIssue({
  item,
  companyId,
  title,
  description,
  payload,
}: {
  item: ThreadViewerScopeItem;
  companyId?: string;
  title: string;
  description: string;
  payload: Record<string, unknown>;
}): Issue {
  const now = new Date();
  return {
    id: `draft:${item.id}`,
    companyId: companyId ?? "",
    projectId: payloadString(payload.projectId),
    goalId: payloadString(payload.goalId),
    parentId: null,
    title,
    description: description || null,
    status: "todo",
    priority: (payloadString(payload.priority) ?? "medium") as Issue["priority"],
    workMode: "planning",
    assigneeAgentId: payloadString(payload.assigneeAgentId),
    assigneeUserId: payloadString(payload.assigneeUserId),
    responsibleUserId: payloadString(payload.responsibleUserId),
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    executionWorkspaceId: null,
    executionEnvironmentId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    source: null,
    originKind: "crew_thread",
    sourceDiscussionId: null,
    reviewerUserId: null,
    reviewerSource: null,
    acceptanceCriteria: [],
    agentCompletionPolicy: "review_required",
    agentCompletionPolicyOverride: null,
    agentCompletionPolicySource: "legacy_backfill",
    agentCompletionPolicySourceId: null,
    agentCompletionPolicyResolvedAt: now,
    dueDate: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    artifactId: item.artifactId ?? null,
    labelIds: payloadStringArray(payload.labelIds),
    createdAt: now,
    updatedAt: now,
  };
}

function DraftTaskScopeItemViewer({
  item,
  scopeItems,
  thread,
  companyId,
  onOpenTab,
  onOpenScopePanel,
  onUpdateScopeItem,
  onCreateScopeOutputItem,
  onReviewScopeItem,
}: {
  item: ThreadViewerScopeItem;
  scopeItems: ThreadViewerScopeItem[];
  thread: DiscussionDetail;
  companyId?: string;
  onOpenTab: (tab: ThreadViewerTab) => void;
  onOpenScopePanel: () => void;
  onUpdateScopeItem?: (
    scopeVersionId: string,
    itemId: string,
    patch: UpdateScopeItemRequest,
  ) => Promise<void> | void;
  onCreateScopeOutputItem?: (
    scopeVersionId: string,
    itemId: string,
    options?: CreateScopeOutputItemOptions,
  ) => Promise<void> | void;
  onReviewScopeItem?: (
    scopeVersionId: string,
    itemId: string,
    status: "draft" | "accepted" | "rejected",
  ) => Promise<void> | void;
}) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? "");
  const [draftPayload, setDraftPayload] = useState<Record<string, unknown>>(() =>
    payloadRecord(item.payload),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const scopeVersionId = item.scopeVersionId ?? null;
  const canSave = Boolean(scopeVersionId && onUpdateScopeItem && title.trim().length > 0);
  const canCreate = Boolean(scopeVersionId && onCreateScopeOutputItem && title.trim().length > 0);
  const sourceEntryIds = Array.isArray(item.sourceEntryIds)
    ? item.sourceEntryIds.filter((value): value is string => typeof value === "string")
    : [];
  const handoffOptions = useMemo(
    () => buildScopeHandoffOptions(item, scopeItems, thread),
    [item, scopeItems, thread],
  );
  const selectedHandoffKeys = useMemo(() => {
    const payloadRefs = handoffRefsFromPayload(draftPayload.handoffRefs);
    const refs = payloadRefs ?? handoffOptions.map((option) => option.ref);
    return new Set(refs.map(handoffRefKey));
  }, [draftPayload.handoffRefs, handoffOptions]);
  const draftIssue = useMemo(
    () => makeDraftIssue({ item, companyId, title, description, payload: draftPayload }),
    [companyId, description, draftPayload, item, title],
  );

  function updateDraftPayload(patch: Record<string, unknown>) {
    setDraftPayload((current) => {
      const next = { ...current, ...patch };
      delete next.status;
      return next;
    });
  }

  function draftPatch(): UpdateScopeItemRequest {
    return {
      title: title.trim(),
      description: description.trim() || null,
      payload: draftPayload,
    };
  }

  function toggleHandoffOption(option: ScopeHandoffOption) {
    const nextSelectedKeys = new Set(selectedHandoffKeys);
    if (nextSelectedKeys.has(option.key)) {
      nextSelectedKeys.delete(option.key);
    } else {
      nextSelectedKeys.add(option.key);
    }
    updateDraftPayload({
      handoffRefs: handoffOptions
        .filter((candidate) => nextSelectedKeys.has(candidate.key))
        .map((candidate) => candidate.ref),
    });
  }

  async function save() {
    if (!scopeVersionId || !onUpdateScopeItem || title.trim().length === 0) return;
    setIsSaving(true);
    try {
      await onUpdateScopeItem(scopeVersionId, item.id, draftPatch());
    } finally {
      setIsSaving(false);
    }
  }

  async function createTask() {
    if (!scopeVersionId || !onCreateScopeOutputItem || title.trim().length === 0) return;
    setIsCreating(true);
    try {
      if (onUpdateScopeItem) {
        await onUpdateScopeItem(scopeVersionId, item.id, draftPatch());
      }
      await onCreateScopeOutputItem(scopeVersionId, item.id);
    } finally {
      setIsCreating(false);
    }
  }

  function reject() {
    if (!scopeVersionId || !onReviewScopeItem) return;
    onReviewScopeItem(scopeVersionId, item.id, "rejected");
  }

  return (
    <div className="h-full min-h-0 overflow-auto p-4" data-testid="thread-draft-task-workbench">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <div className="rounded-lg border border-border bg-card/35 p-4">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <ClipboardList className="h-3 w-3" aria-hidden />
                <span>Task draft</span>
              </div>
              <input
                aria-label="Task title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="mt-2 w-full min-w-0 rounded-md border border-transparent bg-transparent px-0 py-1 text-lg font-semibold leading-snug text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-border focus:bg-background focus:px-2"
                placeholder="Task title"
              />
            </div>
            <span className="shrink-0 rounded-full border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
              Draft
            </span>
          </div>
          <textarea
            aria-label="Task description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="min-h-32 w-full resize-y rounded-md border border-border/70 bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-border"
            placeholder="Describe the outcome, constraints, and handoff context."
          />
        </div>

        <div className="rounded-lg border border-border bg-card/35 p-4">
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Task setup
          </h4>
          <div className="mb-1 flex items-center gap-3 py-1.5">
            <span className="w-20 shrink-0 text-xs text-muted-foreground">Status</span>
            <span className="inline-flex items-center rounded-full border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-200">
              Draft
            </span>
          </div>
          <IssueProperties
            issue={draftIssue}
            onUpdate={updateDraftPayload}
            inline
            hideStatus
          />
        </div>

        <div className="rounded-lg border border-border bg-card/35 p-4">
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Scope handoff
          </h4>
          <dl className="space-y-2 text-xs">
            <MetaRow label="Sources" value={sourceEntryIds.length > 0 ? `${sourceEntryIds.length} message${sourceEntryIds.length === 1 ? "" : "s"}` : "No source messages linked"} />
            <MetaRow label="Artifact" value={item.artifactId ?? "No artifact linked yet"} />
            <MetaRow label="Version" value={item.artifactVersionId ?? null} />
          </dl>
          {handoffOptions.length > 0 ? (
            <div className="mt-3 space-y-2">
              {handoffOptions.map((option) => (
                <label
                  key={option.key}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-border/70 bg-background px-2.5 py-2 text-xs transition-colors hover:bg-muted/30"
                >
                  <input
                    type="checkbox"
                    checked={selectedHandoffKeys.has(option.key)}
                    onChange={() => toggleHandoffOption(option)}
                    className="mt-0.5 h-3.5 w-3.5 rounded border-border bg-background"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-foreground">{option.title}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {option.subtitle}
                    </span>
                  </span>
                  {option.ref.type === "artifact" && option.ref.id ? (
                    <button
                      type="button"
                      className="shrink-0 rounded border border-border/70 px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onOpenTab(artifactRefTab(
                          option.ref.id!,
                          option.title,
                          payloadString(option.ref.metadata?.artifactVersionId),
                          payloadString(option.ref.metadata?.scopeItemId) ?? undefined,
                        ));
                      }}
                    >
                      Open
                    </button>
                  ) : null}
                  <span className="shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                    {option.ref.type.replace("_", " ")}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              No handoff context has been linked to this draft yet.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card/35 p-4">
          <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <FileText className="h-3 w-3" aria-hidden />
            Documents
          </h4>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Documents can be attached after the task is created.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card/35 p-4">
          <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Network className="h-3 w-3" aria-hidden />
            Workspace
          </h4>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Workspace will be created when agent work starts.
          </p>
        </div>

        <div
          data-testid="thread-viewer-draft-task-actions"
          className="sticky bottom-0 -mx-4 flex flex-wrap gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur"
        >
          <Button type="button" size="sm" className="h-8 min-w-[7.5rem] flex-1 text-xs sm:flex-none" onClick={createTask} disabled={!canCreate || isCreating}>
            {isCreating ? "Creating..." : "Create task"}
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 min-w-[7.5rem] flex-1 text-xs sm:flex-none" onClick={save} disabled={!canSave || isSaving}>
            {isSaving ? "Saving..." : "Save draft"}
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 min-w-[7.5rem] flex-1 text-xs sm:flex-none" onClick={reject} disabled={!scopeVersionId || !onReviewScopeItem}>
            Reject
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 min-w-[7.5rem] flex-1 text-xs sm:flex-none" onClick={onOpenScopePanel}>
            Open Scope panel
          </Button>
        </div>
      </div>
    </div>
  );
}

function DraftMemoryScopeItemViewer({
  item,
  companyId,
  onOpenScopePanel,
  onUpdateScopeItem,
  onCreateScopeOutputItem,
  onReviewScopeItem,
}: {
  item: ThreadViewerScopeItem;
  companyId?: string;
  onOpenScopePanel: () => void;
  onUpdateScopeItem?: (
    scopeVersionId: string,
    itemId: string,
    patch: UpdateScopeItemRequest,
  ) => Promise<void> | void;
  onCreateScopeOutputItem?: (
    scopeVersionId: string,
    itemId: string,
    options?: CreateScopeOutputItemOptions,
  ) => Promise<void> | void;
  onReviewScopeItem?: (
    scopeVersionId: string,
    itemId: string,
    status: "draft" | "accepted" | "rejected",
  ) => Promise<void> | void;
}) {
  const payload = useMemo(
    () => payloadRecord(item.payload),
    [item.payload],
  );
  const initialCategory = isMemoryCategory(payloadString(payload.category))
    ? payloadString(payload.category) as MemoryItemCategory
    : "context";
  const initialLayerCandidate =
    payloadString(payload.layer) ?? item.suggestedLayer ?? item.layer ?? null;
  const initialLayer = isMemoryLayer(initialLayerCandidate)
    ? initialLayerCandidate
    : "domain";
  const [title, setTitle] = useState(item.title);
  const [content, setContent] = useState(item.description ?? payloadString(payload.content) ?? "");
  const [category, setCategory] = useState<MemoryItemCategory>(initialCategory);
  const [layer, setLayer] = useState<MemoryItemLayer>(initialLayer);
  const [departmentId, setDepartmentId] = useState(
    payloadString(payload.departmentId) ?? item.suggestedDepartmentId ?? "none",
  );
  const [projectId, setProjectId] = useState(payloadString(payload.projectId) ?? "none");
  const [goalId, setGoalId] = useState(payloadString(payload.goalId) ?? "none");
  const [taskId, setTaskId] = useState(payloadString(payload.taskId) ?? "none");
  const [folderPath, setFolderPath] = useState(payloadString(payload.folderPath) ?? "none");
  const [priority, setPriority] = useState(String(payloadNumber(payload.priority) ?? 0));
  const [tagsText, setTagsText] = useState(payloadStringArray(payload.tags).join(", "));
  const [isSaving, setIsSaving] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const scopeVersionId = item.scopeVersionId ?? null;
  const confidence = payloadString(payload.confidence);
  const canSave = Boolean(scopeVersionId && onUpdateScopeItem && title.trim().length > 0);
  const canCreate = Boolean(scopeVersionId && onCreateScopeOutputItem && title.trim().length > 0);

  const { data: allProjects } = useQuery({
    queryKey: ["thread-memory-workbench-projects", companyId],
    queryFn: () => projectsApi.list(companyId!),
    enabled: Boolean(companyId),
  });
  const departments = useMemo(
    () => (allProjects ?? []).filter((project): project is Project => project.type === "department"),
    [allProjects],
  );
  const projects = useMemo(
    () => (allProjects ?? []).filter((project): project is Project => project.type === "project"),
    [allProjects],
  );
  const selectedProjectId = projectId === "none" ? undefined : projectId;
  const { data: goals } = useQuery({
    queryKey: ["thread-memory-workbench-goals", companyId, selectedProjectId ?? "all"],
    queryFn: () => goalsApi.list(companyId!, selectedProjectId),
    enabled: Boolean(companyId),
  });
  const { data: tasks } = useQuery({
    queryKey: ["thread-memory-workbench-issues", companyId, selectedProjectId ?? "all"],
    queryFn: () => issuesApi.list(companyId!, {
      ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
      taskScope: "all",
    }),
    enabled: Boolean(companyId),
  });
  const selectedDepartmentId = departmentId === "none" ? undefined : departmentId;
  const { data: folders } = useQuery({
    queryKey: ["thread-memory-workbench-folders", companyId, selectedDepartmentId ?? "all"],
    queryFn: () => memoryFoldersApi.list(
      companyId!,
      selectedDepartmentId ? { departmentId: selectedDepartmentId } : undefined,
    ),
    enabled: Boolean(companyId),
  });
  const folderOptions = useMemo(() => {
    const paths = new Map<string, MemoryFolderRecord>();
    for (const folder of folders ?? []) {
      paths.set(folder.path, folder);
    }
    if (folderPath !== "none" && !paths.has(folderPath)) {
      paths.set(folderPath, {
        id: folderPath,
        companyId: companyId ?? "",
        departmentId: selectedDepartmentId ?? null,
        path: folderPath,
        displayName: folderPath,
        icon: null,
        sortOrder: 0,
        seedKey: null,
        createdAt: "",
        updatedAt: "",
      });
    }
    return [...paths.values()];
  }, [companyId, folderPath, folders, selectedDepartmentId]);

  function handleLayerChange(nextLayer: MemoryItemLayer) {
    setLayer(nextLayer);
    if (nextLayer === "identity") {
      setDepartmentId("none");
      setProjectId("none");
      setGoalId("none");
      setTaskId("none");
      return;
    }
    if (nextLayer === "domain") {
      setGoalId("none");
      setTaskId("none");
      return;
    }
    if (nextLayer === "active_context") {
      setTaskId("none");
    }
  }

  const draftPayload = useMemo(() => {
    const parsedPriority = Number.parseInt(priority, 10);
    return {
      ...payload,
      category,
      layer,
      departmentId: noneToNull(departmentId),
      projectId: noneToNull(projectId),
      goalId: noneToNull(goalId),
      taskId: noneToNull(taskId),
      folderPath: folderPath === "none" ? "" : folderPath,
      visibility: "scoped",
      priority: Number.isFinite(parsedPriority) ? parsedPriority : 0,
      tags: tagsText
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    };
  }, [category, departmentId, folderPath, goalId, layer, payload, priority, projectId, tagsText, taskId]);

  function draftPatch(): UpdateScopeItemRequest {
    return {
      title: title.trim(),
      description: content.trim() || null,
      payload: draftPayload,
    };
  }

  async function save() {
    if (!scopeVersionId || !onUpdateScopeItem || title.trim().length === 0) return;
    setIsSaving(true);
    try {
      await onUpdateScopeItem(scopeVersionId, item.id, draftPatch());
    } finally {
      setIsSaving(false);
    }
  }

  async function saveMemory(memoryStatus: "approved" | "pending") {
    if (!scopeVersionId || !onCreateScopeOutputItem || title.trim().length === 0) return;
    setIsCreating(true);
    try {
      if (onUpdateScopeItem) {
        await onUpdateScopeItem(scopeVersionId, item.id, draftPatch());
      }
      await onCreateScopeOutputItem(scopeVersionId, item.id, { memoryStatus });
    } finally {
      setIsCreating(false);
    }
  }

  function reject() {
    if (!scopeVersionId || !onReviewScopeItem) return;
    onReviewScopeItem(scopeVersionId, item.id, "rejected");
  }

  return (
    <div className="h-full min-h-0 overflow-auto p-4" data-testid="thread-draft-memory-viewer">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <div className="rounded-lg border border-border bg-card/35 p-4">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <Database className="h-3 w-3" aria-hidden />
                <span>Draft memory candidate</span>
              </div>
              <input
                aria-label="Draft memory title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="mt-2 w-full min-w-0 rounded-md border border-transparent bg-transparent px-0 py-1 text-lg font-semibold leading-snug text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-border focus:bg-background focus:px-2"
                placeholder="Memory title"
              />
            </div>
            <span className="shrink-0 rounded-full border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
              Pending
            </span>
          </div>
          <textarea
            aria-label="Draft memory content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="min-h-32 w-full resize-y rounded-md border border-border/70 bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-border"
            placeholder="Write the memory in a durable, reusable form. Markdown is fine."
          />
          {content.trim().length === 0 && (
            <p className="mt-2 text-xs text-amber-200/90">Memory content is empty. You can save a draft, but it will not be useful to agents yet.</p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card/35 p-4">
          <h4 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Memory placement
          </h4>
          <div className="grid gap-3 sm:grid-cols-2">
            <MemoryWorkbenchSelect
              label="Category"
              value={category}
              onChange={(value) => setCategory(value as MemoryItemCategory)}
              options={MEMORY_ITEM_CATEGORIES.map((value) => ({
                value,
                label: MEMORY_CATEGORY_LABELS[value],
              }))}
            />
            <MemoryWorkbenchSelect
              label="Layer"
              value={layer}
              onChange={(value) => handleLayerChange(value as MemoryItemLayer)}
              options={MEMORY_ITEM_LAYERS.map((value) => ({
                value,
                label: MEMORY_LAYER_LABELS[value],
              }))}
            />
            <MemoryWorkbenchSelect
              label="Department"
              value={departmentId}
              onChange={setDepartmentId}
              options={[
                { value: "none", label: "None" },
                ...departments.map((department) => ({ value: department.id, label: department.name })),
              ]}
            />
            <MemoryWorkbenchSelect
              label="Project"
              value={projectId}
              onChange={setProjectId}
              options={[
                { value: "none", label: "None" },
                ...projects.map((project) => ({ value: project.id, label: project.name })),
              ]}
            />
            <MemoryWorkbenchSelect
              label="Goal"
              value={goalId}
              onChange={setGoalId}
              options={[
                { value: "none", label: "None" },
                ...(goals ?? []).map((goal: Goal) => ({ value: goal.id, label: goal.title })),
              ]}
            />
            <MemoryWorkbenchSelect
              label="Task"
              value={taskId}
              onChange={setTaskId}
              options={[
                { value: "none", label: "None" },
                ...(tasks ?? []).map((task: Issue) => ({
                  value: task.id,
                  label: task.identifier ? `${task.identifier} ${task.title}` : task.title,
                })),
              ]}
            />
            <MemoryWorkbenchSelect
              label="Folder"
              value={folderPath}
              onChange={setFolderPath}
              options={[
                { value: "none", label: "No folder" },
                ...folderOptions.map((folder) => ({
                  value: folder.path,
                  label: folder.displayName || folder.path,
                })),
              ]}
            />
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Priority
              <input
                aria-label="Memory priority"
                type="number"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
              />
            </label>
            <label className="sm:col-span-2 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Tags
              <input
                aria-label="Memory tags"
                value={tagsText}
                onChange={(event) => setTagsText(event.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
                placeholder="pricing, policy"
              />
            </label>
          </div>
          <dl className="mt-3 space-y-2 border-t border-border/60 pt-3 text-xs">
            <MetaRow label="Confidence" value={confidence} />
            <MetaRow label="Source" value={scopeVersionId ? `thread_scope_version:${scopeVersionId}` : null} />
          </dl>
          {layer === "working" && taskId === "none" && (
            <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-100">
              Working memory is most useful when linked to a task. You can still save it and attach the task later.
            </p>
          )}
        </div>

        <div
          data-testid="thread-viewer-draft-memory-actions"
          className="sticky bottom-0 -mx-4 grid grid-cols-2 gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur lg:grid-cols-5"
        >
          <Button type="button" size="sm" className="h-8 min-w-0 text-xs" onClick={() => saveMemory("approved")} disabled={!canCreate || isCreating}>
            {isCreating ? "Saving..." : "Save approved"}
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 min-w-0 text-xs" onClick={() => saveMemory("pending")} disabled={!canCreate || isCreating}>
            Save pending
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 min-w-0 text-xs" onClick={save} disabled={!canSave || isSaving}>
            {isSaving ? "Saving..." : "Save changes"}
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 min-w-0 text-xs" onClick={reject} disabled={!scopeVersionId || !onReviewScopeItem}>
            Reject
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 min-w-0 text-xs" onClick={onOpenScopePanel}>
            Open Scope panel
          </Button>
        </div>
      </div>
    </div>
  );
}

function MemoryWorkbenchSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function MemoryLinkedViewer({ payload }: { payload: ThreadViewerMemoryPayload }) {
  const queryClient = useQueryClient();
  const { data: memory, isLoading, isError } = useQuery({
    queryKey: ["thread-viewer-memory", payload.companyId, payload.memoryId],
    queryFn: () => memoryApi.get(payload.companyId, payload.memoryId),
    enabled: Boolean(payload.companyId && payload.memoryId),
  });
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftCategory, setDraftCategory] = useState<MemoryItemCategory>("context");
  const [draftLayer, setDraftLayer] = useState<MemoryItemLayer>("domain");
  const [draftDepartmentId, setDraftDepartmentId] = useState("none");
  const [draftProjectId, setDraftProjectId] = useState("none");
  const [draftGoalId, setDraftGoalId] = useState("none");
  const [draftTaskId, setDraftTaskId] = useState("none");
  const [draftFolderPath, setDraftFolderPath] = useState("none");
  const [draftPriority, setDraftPriority] = useState("0");
  const [draftTagsText, setDraftTagsText] = useState("");
  const { data: allProjects } = useQuery({
    queryKey: ["thread-viewer-memory-projects", payload.companyId],
    queryFn: () => projectsApi.list(payload.companyId),
    enabled: Boolean(payload.companyId),
  });
  const projects = (allProjects ?? []) as Project[];
  const departments = useMemo(
    () => projects.filter((project) => project.type === "department"),
    [projects],
  );
  const projectOptions = useMemo(
    () => projects.filter((project) => project.type === "project"),
    [projects],
  );
  const selectedProjectId = draftProjectId === "none" ? undefined : draftProjectId;
  const { data: goals } = useQuery({
    queryKey: ["thread-viewer-memory-goals", payload.companyId, selectedProjectId ?? "all"],
    queryFn: () => goalsApi.list(payload.companyId, selectedProjectId),
    enabled: Boolean(payload.companyId),
  });
  const { data: tasks } = useQuery({
    queryKey: ["thread-viewer-memory-tasks", payload.companyId, selectedProjectId ?? "all"],
    queryFn: () => issuesApi.list(payload.companyId, {
      ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
      taskScope: "all",
    }),
    enabled: Boolean(payload.companyId),
  });
  const selectedDepartmentId = draftDepartmentId === "none" ? undefined : draftDepartmentId;
  const { data: folders } = useQuery({
    queryKey: ["thread-viewer-memory-folders", payload.companyId, selectedDepartmentId ?? "all"],
    queryFn: () =>
      memoryFoldersApi.list(
        payload.companyId,
        selectedDepartmentId ? { departmentId: selectedDepartmentId } : undefined,
      ),
    enabled: Boolean(payload.companyId),
  });
  const folderOptions = useMemo(() => {
    const paths = new Map<string, MemoryFolderRecord>();
    for (const folder of folders ?? []) {
      paths.set(folder.path, folder);
    }
    if (draftFolderPath !== "none" && !paths.has(draftFolderPath)) {
      paths.set(draftFolderPath, {
        id: draftFolderPath,
        companyId: payload.companyId,
        departmentId: selectedDepartmentId ?? null,
        path: draftFolderPath,
        displayName: draftFolderPath,
        icon: null,
        sortOrder: 0,
        seedKey: null,
        createdAt: "",
        updatedAt: "",
      });
    }
    return [...paths.values()];
  }, [draftFolderPath, folders, payload.companyId, selectedDepartmentId]);
  const memoryQueryKey = ["thread-viewer-memory", payload.companyId, payload.memoryId] as const;
  const scopeVersionsQueryKey = ["thread-scope-versions", payload.companyId] as const;
  const approveMutation = useMutation({
    mutationFn: () => memoryApi.approve(payload.companyId, payload.memoryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memoryQueryKey });
      queryClient.invalidateQueries({ queryKey: scopeVersionsQueryKey });
    },
  });
  const rejectMutation = useMutation({
    mutationFn: () => memoryApi.reject(payload.companyId, payload.memoryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memoryQueryKey });
      queryClient.invalidateQueries({ queryKey: scopeVersionsQueryKey });
    },
  });
  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!memory) return null;
      const parsedPriority = Number.parseInt(draftPriority, 10);
      const tags = draftTagsText
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);

      const updated = await memoryApi.update(payload.companyId, payload.memoryId, {
        title: draftTitle.trim(),
        content: draftContent.trim(),
        category: draftCategory,
        projectId: noneToNull(draftProjectId),
        goalId: noneToNull(draftGoalId),
        taskId: noneToNull(draftTaskId),
        priority: Number.isFinite(parsedPriority) ? parsedPriority : 0,
        tags,
      });

      const normalizedMemoryLayer = isMemoryLayer(memory.layer ?? null)
        ? memory.layer as MemoryItemLayer
        : "domain";
      const shouldChangeLayer =
        normalizedMemoryLayer !== draftLayer ||
        (memory.departmentId ?? "none") !== draftDepartmentId ||
        (memory.goalId ?? "none") !== draftGoalId ||
        (memory.taskId ?? "none") !== draftTaskId;
      if (shouldChangeLayer) {
        await memoryApi.changeLayer(payload.companyId, payload.memoryId, {
          newLayer: draftLayer,
          departmentId: noneToNull(draftDepartmentId),
          goalId: noneToNull(draftGoalId),
          taskId: noneToNull(draftTaskId),
        });
      }

      const memoryRecord = memory as typeof memory & { folderPath?: string | null };
      if (draftFolderPath !== "none" && (memoryRecord.folderPath ?? "") !== draftFolderPath) {
        await memoryApi.moveItem(payload.companyId, payload.memoryId, draftFolderPath);
      }

      return updated;
    },
    onSuccess: () => {
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: memoryQueryKey });
      queryClient.invalidateQueries({ queryKey: ["memory-items", payload.companyId] });
      queryClient.invalidateQueries({ queryKey: scopeVersionsQueryKey });
    },
  });

  useEffect(() => {
    if (!memory) return;
    const memoryRecord = memory as typeof memory & { folderPath?: string | null };
    setDraftTitle(memory.title ?? "");
    setDraftContent(memory.content ?? "");
    setDraftCategory(isMemoryCategory(memory.category ?? null) ? memory.category as MemoryItemCategory : "context");
    setDraftLayer(isMemoryLayer(memory.layer ?? null) ? memory.layer as MemoryItemLayer : "domain");
    setDraftDepartmentId(memory.departmentId ?? "none");
    setDraftProjectId(memory.projectId ?? "none");
    setDraftGoalId(memory.goalId ?? "none");
    setDraftTaskId(memory.taskId ?? "none");
    setDraftFolderPath(memoryRecord.folderPath ?? "none");
    setDraftPriority(String(memory.priority ?? 0));
    setDraftTagsText(Array.isArray(memory.tags) ? memory.tags.join(", ") : "");
  }, [memory]);

  if (isLoading) return <CenteredMessage title="Loading memory" body="Fetching the accepted scope output." />;
  if (isError || !memory) {
    return <CenteredMessage title="Memory unavailable" body="Could not load this memory item." />;
  }

  const memoryRecord = memory as typeof memory & { folderPath?: string | null };
  const departmentLabel = labelById(
    departments,
    memory.departmentId ?? null,
    (department) => department.name,
  );
  const projectLabel = labelById(
    projectOptions,
    memory.projectId ?? null,
    (project) => project.name,
  );
  const goalLabel = labelById(goals, memory.goalId ?? null, (goal) => goal.title);
  const taskLabel = labelById(tasks, memory.taskId ?? null, (task) =>
    task.identifier ? `${task.identifier} ${task.title}` : task.title,
  );
  const categoryLabel = isMemoryCategory(memory.category ?? null)
    ? MEMORY_CATEGORY_LABELS[memory.category as MemoryItemCategory]
    : memory.category ?? "Memory";
  const layerLabel = isMemoryLayer(memory.layer ?? null)
    ? `${MEMORY_LAYER_LABELS[memory.layer as MemoryItemLayer]} (${memory.layer})`
    : memory.layer ?? null;
  const folderLabel =
    folders?.find((folder) => folder.path === memoryRecord.folderPath)?.displayName ??
    memoryRecord.folderPath ??
    "No folder";

  return (
    <div className="h-full min-h-0 overflow-auto p-4" data-testid="thread-viewer-memory">
      <LinkedViewerHeader
        icon={Database}
        eyebrow={memory.status === "pending" ? "Pending memory" : categoryLabel}
        title={memory.title}
        status={memory.status}
        href={`/memory/${memory.id}`}
      />
      <div
        data-testid="thread-viewer-linked-memory-actions"
        className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end"
      >
        {memory.status === "pending" && (
          <>
            <Button
              type="button"
              size="sm"
              className="h-8 min-w-0 text-xs"
              onClick={() => approveMutation.mutate()}
              disabled={approveMutation.isPending || rejectMutation.isPending}
            >
              Approve
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 min-w-0 text-xs"
              onClick={() => rejectMutation.mutate()}
              disabled={approveMutation.isPending || rejectMutation.isPending}
            >
              Reject
            </Button>
          </>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 min-w-0 text-xs"
          onClick={() => setIsEditing((current) => !current)}
        >
          {isEditing ? "Cancel edit" : "Edit memory"}
        </Button>
      </div>
      {isEditing ? (
        <div className="mt-4 rounded-lg border border-border/60 bg-card/35 p-3">
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Memory title
            <input
              aria-label="Memory title"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
            />
          </label>
          <label className="mt-3 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Memory content
            <textarea
              aria-label="Memory content"
              value={draftContent}
              onChange={(event) => setDraftContent(event.target.value)}
              className="mt-1 min-h-28 w-full resize-y rounded-md border border-border bg-background px-2 py-2 text-xs leading-relaxed text-foreground"
            />
          </label>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <MemoryWorkbenchSelect
              label="Category"
              value={draftCategory}
              onChange={(value) => setDraftCategory(value as MemoryItemCategory)}
              options={MEMORY_ITEM_CATEGORIES.map((value) => ({
                value,
                label: MEMORY_CATEGORY_LABELS[value],
              }))}
            />
            <MemoryWorkbenchSelect
              label="Layer"
              value={draftLayer}
              onChange={(value) => {
                const nextLayer = value as MemoryItemLayer;
                setDraftLayer(nextLayer);
                if (nextLayer === "identity") {
                  setDraftDepartmentId("none");
                  setDraftProjectId("none");
                  setDraftGoalId("none");
                  setDraftTaskId("none");
                  return;
                }
                if (nextLayer === "domain") {
                  setDraftGoalId("none");
                  setDraftTaskId("none");
                  return;
                }
                if (nextLayer === "active_context") {
                  setDraftTaskId("none");
                }
              }}
              options={MEMORY_ITEM_LAYERS.map((value) => ({
                value,
                label: MEMORY_LAYER_LABELS[value],
              }))}
            />
            <MemoryWorkbenchSelect
              label="Department"
              value={draftDepartmentId}
              onChange={setDraftDepartmentId}
              options={[
                { value: "none", label: "None" },
                ...departments.map((department) => ({ value: department.id, label: department.name })),
              ]}
            />
            <MemoryWorkbenchSelect
              label="Project"
              value={draftProjectId}
              onChange={setDraftProjectId}
              options={[
                { value: "none", label: "None" },
                ...projectOptions.map((project) => ({ value: project.id, label: project.name })),
              ]}
            />
            <MemoryWorkbenchSelect
              label="Goal"
              value={draftGoalId}
              onChange={setDraftGoalId}
              options={[
                { value: "none", label: "None" },
                ...(goals ?? []).map((goal: Goal) => ({ value: goal.id, label: goal.title })),
              ]}
            />
            <MemoryWorkbenchSelect
              label="Task"
              value={draftTaskId}
              onChange={setDraftTaskId}
              options={[
                { value: "none", label: "None" },
                ...(tasks ?? []).map((task: Issue) => ({
                  value: task.id,
                  label: task.identifier ? `${task.identifier} ${task.title}` : task.title,
                })),
              ]}
            />
            <MemoryWorkbenchSelect
              label="Folder"
              value={draftFolderPath}
              onChange={setDraftFolderPath}
              options={[
                { value: "none", label: "No folder" },
                ...folderOptions.map((folder) => ({
                  value: folder.path,
                  label: folder.displayName || folder.path,
                })),
              ]}
            />
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Priority
              <input
                aria-label="Priority"
                type="number"
                value={draftPriority}
                onChange={(event) => setDraftPriority(event.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
              />
            </label>
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:col-span-2">
              Tags
              <input
                aria-label="Tags"
                value={draftTagsText}
                onChange={(event) => setDraftTagsText(event.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
                placeholder="pricing, policy"
              />
            </label>
          </div>
          <Button
            type="button"
            size="sm"
            className="mt-3 h-8 text-xs"
            onClick={() => updateMutation.mutate()}
            disabled={updateMutation.isPending || draftTitle.trim().length === 0}
          >
            {updateMutation.isPending ? "Saving..." : "Save memory"}
          </Button>
        </div>
      ) : memory.content ? (
        <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {memory.content}
        </p>
      ) : null}
      <div className="mt-4 rounded-lg border border-border/60 bg-card/35 p-3">
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Memory placement
        </h4>
        <dl className="space-y-2 text-xs">
          <MetaRow label="Category" value={categoryLabel} />
          <MetaRow label="Layer" value={layerLabel} />
          <MetaRow label="Folder" value={folderLabel} />
          <MetaRow label="Department" value={departmentLabel} />
          <MetaRow label="Project" value={projectLabel} />
          <MetaRow label="Goal" value={goalLabel} />
          <MetaRow label="Task" value={taskLabel} />
        </dl>
      </div>
      <dl className="mt-4 space-y-2 text-xs">
        <MetaRow label="Source artifact" value={memory.sourceArtifactId ?? null} />
        <MetaRow label="Updated" value={formatDateTime(memory.updatedAt ?? null)} />
        <MetaRow label="Scope item" value={payload.scopeItemId ?? null} />
      </dl>
    </div>
  );
}

function LinkedViewerHeader({
  icon: Icon,
  eyebrow,
  title,
  status,
  href,
}: {
  icon: typeof LayoutGrid;
  eyebrow: string | null;
  title: string;
  status: string | null;
  href: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Icon className="h-3 w-3" aria-hidden />
          <span className="truncate">{eyebrow}</span>
        </div>
        <h3 className="mt-1 text-sm font-semibold leading-snug">{title}</h3>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {status && (
          <span className="rounded-full border border-border px-2 py-0.5 text-[10px] capitalize text-muted-foreground">
            {status}
          </span>
        )}
        <Button asChild type="button" variant="ghost" size="icon" className="h-7 w-7" title="Open full view">
          <a href={href} aria-label="Open full view">
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-foreground">{value}</dd>
    </div>
  );
}

function formatDateTime(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function AssetAttachmentViewer({ attachment }: { attachment: DiscussionEntryAttachment }) {
  const assetId = attachment.currentVersionAssetId ?? attachment.assetId;
  const filename =
    attachment.currentVersionFilename ||
    attachment.assetOriginalFilename ||
    attachment.artifactTitle ||
    "Attached file";
  const contentType =
    attachment.currentVersionContentType ||
    attachment.assetContentType ||
    "application/octet-stream";

  if (!assetId) {
    return <CenteredMessage title="File unavailable" body="This attachment has no asset id." />;
  }

  const viewer = resolveViewer({
    contentType,
    filename,
    assetId,
    assetUrl: `/api/assets/${assetId}/content`,
  });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="thread-asset-viewer">
      <ViewerHeader title={filename} subtitle={viewer.label} url={viewer.assetUrl} />
      <SharedContentViewer viewer={viewer} filename={filename} />
    </div>
  );
}

function ArtifactAttachmentViewer({
  artifactId,
  artifactVersionId,
  scopeItemId,
}: {
  artifactId: string | null;
  artifactVersionId?: string | null;
  scopeItemId?: string | null;
}) {
  const { data: artifact, isLoading, isError } = useQuery({
    queryKey: ["thread-viewer-artifact", artifactId],
    queryFn: () => artifactsApi.get(artifactId!),
    enabled: Boolean(artifactId),
  });

  if (!artifactId) {
    return <CenteredMessage title="Artifact unavailable" body="This attachment has no artifact id." />;
  }
  if (isLoading) return <CenteredMessage title="Loading artifact" body="Fetching the latest version." />;
  if (isError || !artifact) {
    return <CenteredMessage title="Artifact unavailable" body="Could not load this artifact." />;
  }

  const version =
    artifact.versions.find((candidate) => candidate.id === artifactVersionId) ??
    artifact.versions[0] ??
    null;
  if (!version) {
    return <CenteredMessage title={artifact.title} body="This artifact has no versions yet." />;
  }

  const inlineContent = version.content ?? null;
  const filename = filenameForArtifactVersion(artifact, version);
  const contentType = contentTypeForArtifactVersion(artifact, version);
  const assetUrl = assetUrlForArtifactVersion(version);
  const viewer = resolveViewer({
    contentType,
    filename,
    assetId: version.assetId,
    assetUrl,
  });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="thread-artifact-viewer">
      <ViewerHeader
        title={artifact.title}
        subtitle={`${viewer.label} - v${version.versionNumber}`}
        url={viewer.assetUrl}
      />
      <div className="shrink-0 border-b border-border bg-muted/20 px-3 py-2">
        <dl className="grid gap-1 text-xs sm:grid-cols-2">
          <MetaRow label="Type" value={artifact.type ?? null} />
          <MetaRow label="Status" value={artifact.status ?? null} />
          <MetaRow label="Version" value={`v${version.versionNumber}`} />
          <MetaRow label="Changelog" value={version.changelog ?? null} />
          <MetaRow label="Scope item" value={scopeItemId ?? null} />
          <MetaRow label="Updated" value={formatDateTime(version.createdAt ?? null)} />
        </dl>
        {artifact.description && (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{artifact.description}</p>
        )}
      </div>
      <SharedContentViewer
        viewer={viewer}
        filename={filename}
        inlineTextContent={inlineContent}
      />
    </div>
  );
}

function MapPlaceholder({
  payload,
  thread,
}: {
  payload?: ThreadViewerMapPayload;
  thread: DiscussionDetail;
}) {
  const global = payload?.scope === "global";
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-5" data-testid="thread-map-placeholder">
      <div className="w-full max-w-sm rounded-md border border-border bg-muted/20 p-4 text-center">
        <Network className="mx-auto mb-3 h-6 w-6 text-muted-foreground" aria-hidden />
        <div className="text-sm font-semibold">{global ? "Global map" : "Thread map"}</div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {global
            ? "The global discussions relationship map will be wired here later."
            : `Relationships for "${thread.title}" will be wired here later.`}
        </p>
      </div>
    </div>
  );
}

function ViewerHeader({
  title,
  subtitle,
  url,
}: {
  title: string;
  subtitle: string;
  url: string | null;
}) {
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="truncate text-[11px] text-muted-foreground">{subtitle}</div>
      </div>
      {url && (
        <Button asChild type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs">
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open
          </a>
        </Button>
      )}
    </div>
  );
}

function CenteredMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-5">
      <div className="max-w-xs text-center">
        <div className="text-sm font-semibold">{title}</div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

