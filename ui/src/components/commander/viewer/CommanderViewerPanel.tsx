import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, FileText, Globe, Home, Inbox, ListTodo, MessageSquare, Package, ShieldCheck, StickyNote } from "lucide-react";
import type { ShowRef } from "@armyofagents/shared";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "../../../lib/utils";
import { COMMANDER_PANEL_CARD } from "../commanderChrome";
import { hubItemsApi } from "../../../api/hub-items";
import { BrowserViewer } from "../../viewers/BrowserViewer";
import { ViewerTabs, type ViewerTabModel } from "../../viewers/ViewerTabs";
import { SharedContentViewer } from "../../viewers/SharedContentViewer";
import { resolveViewer } from "../../viewers/viewer-registry";
import {
  ArtifactTabBody,
  AssetRefTabBody,
  DiscussionRefTabBody,
  LoadingBody,
  MemoryItemRefTabBody,
  OutputRefTabBody,
  UnavailableBody,
} from "../../viewers/refBodies";
import { CommanderViewerHome } from "./CommanderViewerHome";
import { TaskDetail } from "../../TaskDetail";
import { ApprovalDetailCore } from "../../approval/ApprovalDetailCore";
import { HubActionBar } from "../../hub/HubActionBar";
import { HubTabBody } from "../../hub/HubTabBody";
import { hubTabForItem } from "../../hub/hubRegistry";
import type { HubTab, HubTaskPayload, HubThreadPayload } from "../../hub/hubViewerModel";
import { useHubItemMutations } from "../../../hooks/useHubItemMutations";
import type { CommanderViewerApi } from "./useCommanderViewer";
import type { ConversationViewerState, ViewerTab } from "./commanderViewerModel";

// ---------------------------------------------------------------------------
// Tab body sub-components
// (The self-fetching ref bodies — Artifact/Asset/Output/Memory/Discussion +
// the shared LoadingBody/UnavailableBody primitives — now live in the shared
// `../../viewers/refBodies` module so non-Commander surfaces can reuse them.)
// ---------------------------------------------------------------------------

interface ReplyTabBodyProps {
  replyContent: string;
}

function ReplyTabBody({ replyContent }: ReplyTabBodyProps) {
  const viewer = resolveViewer({ contentType: "text/markdown", filename: "reply.md" });
  return (
    <SharedContentViewer viewer={viewer} filename="Commander reply" inlineTextContent={replyContent} />
  );
}

interface TaskDetailTabBodyProps {
  tab: ViewerTab;
  onDismiss: () => void;
}

function TaskDetailTabBody({ tab, onDismiss }: TaskDetailTabBodyProps) {
  // tab.refId is the issueId. Only mounted while active → active is true; TaskDetail
  // gates its own (incl. polling) queries on `active`.
  return <TaskDetail issueId={tab.refId} active onDismiss={onDismiss} />;
}

function openNestedHubTab(tab: HubTab, onOpenTask: (issueId: string, title: string) => void) {
  if (tab.kind !== "task") return;
  const payload = tab.payload as HubTaskPayload | undefined;
  if (payload) onOpenTask(payload.issueId, tab.title);
}

function InboxRefTabBody({
  tab,
  companyId,
  onOpenTask,
}: {
  tab: ViewerTab;
  companyId: string;
  onOpenTask: (issueId: string, title: string) => void;
}) {
  const mutations = useHubItemMutations(companyId);
  const [undoAction, setUndoAction] = useState<
    | {
        label: string;
        itemId: string;
        auditId?: string;
        expectedVersion?: number;
        restore?: { kind: "unsnooze" | "undismiss" };
      }
    | null
  >(null);
  const {
    data: item,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["hub-items", companyId, "item", tab.refId],
    queryFn: () => hubItemsApi.getOne(companyId, tab.refId),
    enabled: Boolean(companyId && tab.refId),
  });

  if (isLoading) return <LoadingBody />;

  if (isError || !item) {
    return (
      <UnavailableBody message="This Inbox item is no longer available, or you do not have access to it." />
    );
  }

  const title = item?.title ?? tab.inputRef?.label ?? tab.title;
  const summary = item?.summary ?? tab.inputRef?.detail ?? null;
  const meta = item
    ? [item.semanticType, item.priority, item.lane].filter(Boolean).join(" · ")
    : tab.inputRef?.source ?? "Inbox";

  const hubTab = hubTabForItem(item);
  const threadPayload = hubTab.kind === "thread"
    ? (hubTab.payload as HubThreadPayload | undefined)
    : undefined;
  const mutationError = [
    mutations.dismiss.error,
    mutations.snooze.error,
    mutations.markUnread.error,
    mutations.act.error,
    mutations.undo.error,
  ].find(Boolean);

  const handleUndo = () => {
    if (!undoAction) return;
    if (undoAction.restore) {
      void mutations.undoPersonalState({
        itemId: undoAction.itemId,
        restore: undoAction.restore,
      });
    } else if (undoAction.auditId && undoAction.expectedVersion != null) {
      mutations.undo.mutate({
        itemId: undoAction.itemId,
        payload: {
          auditId: undoAction.auditId,
          expectedVersion: undoAction.expectedVersion,
        },
      });
    }
    setUndoAction(null);
  };

  const actionBar = (
    <HubActionBar
      item={item}
      onDismiss={(itemId) => {
        mutations.dismiss.mutate(itemId);
        setUndoAction({ label: "dismiss", itemId, restore: { kind: "undismiss" } });
      }}
      onSnooze={(itemId) => {
        const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        mutations.snooze.mutate({ itemId, until });
        setUndoAction({ label: "snooze", itemId, restore: { kind: "unsnooze" } });
      }}
      onLifecycleAction={(target, action) => {
        mutations.act.mutate(
          {
            itemId: target.id,
            payload: { action, expectedVersion: target.version },
          },
          {
            onSuccess: (result) => {
              setUndoAction({
                label: action,
                itemId: target.id,
                auditId: result.auditId,
                expectedVersion: result.item.version,
              });
            },
          },
        );
      }}
      onMarkUnread={(itemId) => mutations.markUnread.mutate(itemId)}
      undoAction={undoAction ? { label: undoAction.label, onUndo: handleUndo } : null}
    />
  );

  if (hubTab.kind === "notification") {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="commander-inbox-ref-body">
        {actionBar}
        {mutationError ? (
          <p className="border-b border-border bg-destructive/5 px-4 py-2 text-xs text-destructive" role="alert">
            The Inbox action could not be completed. Refresh the item and try again.
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Inbox className="size-4" aria-hidden />
        <span>{meta}</span>
      </div>
      <h2 className="mt-2 text-base font-semibold leading-snug text-foreground">{title}</h2>
      {summary ? (
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{summary}</p>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">No further details.</p>
      )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="commander-inbox-ref-body">
      {actionBar}
      {mutationError ? (
        <p className="border-b border-border bg-destructive/5 px-4 py-2 text-xs text-destructive" role="alert">
          The Inbox action could not be completed. Refresh the item and try again.
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        {threadPayload?.discussionId ? (
          <DiscussionRefTabBody
            companyId={companyId}
            refId={threadPayload.discussionId}
            fallbackTitle={item.title}
          />
        ) : (
          <HubTabBody
            tab={hubTab}
            companyId={companyId}
            activeItem={item}
            resolveHubItem={(itemId) => (itemId === item.id ? item : undefined)}
            onOpenTab={(nextTab) => openNestedHubTab(nextTab, onOpenTask)}
          />
        )}
      </div>
    </div>
  );
}

function NoteRefTabBody({ tab }: { tab: ViewerTab }) {
  return (
    <div className="h-full overflow-auto p-4" data-testid="commander-note-ref-body">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <StickyNote className="size-4" aria-hidden />
        <span>Personal note</span>
      </div>
      <h2 className="mt-2 text-base font-semibold leading-snug text-foreground">{tab.inputRef?.label ?? tab.title}</h2>
      {tab.inputRef?.detail ? (
        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{tab.inputRef.detail}</p>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">No note body was included with this reference.</p>
      )}
    </div>
  );
}

function ApprovalRefTabBody({
  tab,
  onOpenTask,
}: {
  tab: ViewerTab;
  onOpenTask: (issueId: string, title: string) => void;
}) {
  if (!tab.inputRef?.source || tab.inputRef.source === "approval") {
    return (
      <ApprovalDetailCore
        approvalId={tab.refId}
        embedded
        onOpenTab={(nextTab) => openNestedHubTab(nextTab, onOpenTask)}
      />
    );
  }

  return (
    <div className="h-full overflow-auto p-4" data-testid="commander-approval-ref-body">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <ShieldCheck className="size-4" aria-hidden />
        <span>{tab.inputRef.source.replaceAll("_", " ")}</span>
      </div>
      <h2 className="mt-2 text-base font-semibold leading-snug text-foreground">
        {tab.inputRef.label}
      </h2>
      {tab.inputRef.detail ? (
        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
          {tab.inputRef.detail}
        </p>
      ) : null}
      <p className="mt-4 text-xs text-muted-foreground">
        Review and act on this item from its Cockpit card or open its full feature page.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab body switcher (shared between desktop panel + mobile sheet)
// ---------------------------------------------------------------------------

interface TabBodySwitchProps {
  activeId: string;
  activeTab: ViewerTab | undefined;
  companyId: string;
  conversationRefs: ShowRef[];
  onOpen: (ref: ShowRef) => void;
  onCloseTab: (id: string) => void;
  onOpenTask?: (issueId: string, title: string) => void;
}

export function TabBodySwitch({
  activeId,
  activeTab,
  companyId,
  conversationRefs,
  onOpen,
  onCloseTab,
  onOpenTask = () => {},
}: TabBodySwitchProps) {
  if (activeId === "home" || !activeTab) {
    return (
      <CommanderViewerHome
        companyId={companyId}
        conversationRefs={conversationRefs}
        onOpen={onOpen}
      />
    );
  }

  if (activeTab.kind === "artifact") {
    return <ArtifactTabBody refId={activeTab.refId} versionId={activeTab.versionId} />;
  }

  if (activeTab.kind === "reply" && activeTab.replyContent != null) {
    return <ReplyTabBody replyContent={activeTab.replyContent} />;
  }

  if (activeTab.kind === "browser") {
    // Keyed per tab so switching between two browser tabs remounts with the
    // right initialUrl (BrowserViewer seeds its url state on mount).
    return <BrowserViewer key={activeTab.id} initialUrl={activeTab.url ?? "about:blank"} />;
  }

  if (activeTab.kind === "task") {
    // Keyed per tab so switching between two task tabs remounts — TaskDetail holds
    // internal UI state (sidebarMode, detailTab, …) that must not bleed across issues.
    return (
      <TaskDetailTabBody
        key={activeTab.id}
        tab={activeTab}
        onDismiss={() => onCloseTab(activeTab.id)}
      />
    );
  }

  if (activeTab.kind === "discussion") {
    return (
      <DiscussionRefTabBody
        companyId={companyId}
        refId={activeTab.refId}
        fallbackTitle={activeTab.title}
        fallbackLabel={activeTab.inputRef?.label}
        fallbackSource={activeTab.inputRef?.source}
        fallbackDetail={activeTab.inputRef?.detail}
      />
    );
  }

  if (activeTab.kind === "approval") {
    return <ApprovalRefTabBody tab={activeTab} onOpenTask={onOpenTask} />;
  }

  if (activeTab.kind === "inbox") {
    return (
      <InboxRefTabBody
        key={activeTab.id}
        tab={activeTab}
        companyId={companyId}
        onOpenTask={onOpenTask}
      />
    );
  }

  if (activeTab.kind === "note") {
    return <NoteRefTabBody tab={activeTab} />;
  }

  if (activeTab.kind === "asset") {
    return <AssetRefTabBody key={activeTab.id} refId={activeTab.refId} viewerKind={activeTab.viewerKind} />;
  }

  if (activeTab.kind === "output") {
    return (
      <OutputRefTabBody
        key={activeTab.id}
        companyId={companyId}
        refId={activeTab.refId}
        viewerKind={activeTab.viewerKind}
      />
    );
  }

  if (activeTab.kind === "memory_item") {
    return <MemoryItemRefTabBody key={activeTab.id} companyId={companyId} refId={activeTab.refId} />;
  }

  return (
    <UnavailableBody message="This item is no longer available (it may have been deleted, or you may not have access)." />
  );
}

// ---------------------------------------------------------------------------
// Tab model builder (shared between Panel and AgentPanelContent)
// ---------------------------------------------------------------------------

export function buildViewerTabModels(state: ConversationViewerState): ViewerTabModel[] {
  return [
    { id: "home", kind: "home", title: "Home", icon: Home, closeable: false },
    ...state.tabs.map(
      (t): ViewerTabModel => ({
        id: t.id,
        kind: t.kind,
        title: t.title,
        icon:
          t.kind === "browser"
            ? Globe
            : t.kind === "task"
              ? ListTodo
              : t.kind === "discussion"
                ? MessageSquare
                : t.kind === "approval"
                  ? ShieldCheck
                  : t.kind === "inbox"
                    ? Inbox
                    : t.kind === "note"
                      ? StickyNote
                      : t.kind === "memory_item"
                        ? Brain
                        : t.kind === "output"
                          ? Package
                          : FileText,
      }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Desktop detail card (owned width/height comes from the Panel parent)
// ---------------------------------------------------------------------------

export interface CommanderViewerDetailProps {
  viewer: CommanderViewerApi;
  companyId: string;
  conversationRefs: ShowRef[];
  activeTab: ViewerTab | undefined;
  tabModels: ViewerTabModel[];
  /** Global bridge: collapse the panel (persists) — wired by AgentPanelContent. */
  onCollapse: () => void;
  onOpenTask: (issueId: string, title: string) => void;
}

export function CommanderViewerDetail({
  viewer,
  companyId,
  conversationRefs,
  activeTab,
  tabModels,
  onCollapse,
  onOpenTask,
}: CommanderViewerDetailProps) {
  const state = viewer.state;
  const activeKey = {
    id: state.activeId,
    kind: state.activeId === "home" ? "home" : (activeTab?.kind ?? "home"),
  };
  return (
    <div
      data-testid="commander-viewer-panel"
      className={cn("relative flex h-full min-w-0 flex-1 flex-col", COMMANDER_PANEL_CARD)}
    >
      <ViewerTabs
        tabs={tabModels}
        activeKey={activeKey}
        onActivate={(tab) => viewer.activate(tab.id)}
        onClose={(tab) => viewer.close(tab.id)}
        onAdd={() => viewer.activate("home")}
        addLabel="Open viewer home"
        onToggleCollapse={onCollapse}
        headerTestId="commander-viewer-tabs"
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <TabBodySwitch
          activeId={state.activeId}
          activeTab={activeTab}
          companyId={companyId}
          conversationRefs={conversationRefs}
          onOpen={viewer.openRef}
          onCloseTab={viewer.close}
          onOpenTask={onOpenTask}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile floating pill
// ---------------------------------------------------------------------------

interface MobilePillProps {
  viewer: CommanderViewerApi;
}

function MobilePill({ viewer }: MobilePillProps) {
  return (
    <button
      type="button"
      data-testid="commander-viewer-pill"
      aria-label={
        viewer.pendingBadge > 0
          ? `Open viewer — ${viewer.pendingBadge} new`
          : "Open viewer"
      }
      onClick={() => {
        viewer.expand();
        viewer.clearBadge();
      }}
      className="fixed bottom-20 right-4 z-50 flex h-11 items-center gap-2 rounded-full border border-border bg-card px-3 shadow-lg lg:hidden"
    >
      <FileText className="size-4 text-muted-foreground" />
      {viewer.pendingBadge > 0 && (
        <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">
          {viewer.pendingBadge}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main export — mobile only (desktop is composed by AgentPanelContent's Group)
// ---------------------------------------------------------------------------

export interface CommanderViewerPanelProps {
  viewer: CommanderViewerApi;
  companyId: string;
  conversationRefs: ShowRef[];
  /** True on mobile breakpoints — caller passes (e.g. from window width check). */
  isMobile: boolean;
  onOpenTask: (issueId: string, title: string) => void;
}

export function CommanderViewerPanel({
  viewer,
  companyId,
  conversationRefs,
  isMobile,
  onOpenTask,
}: CommanderViewerPanelProps) {
  const state = viewer.state;
  const activeTab = state.tabs.find((t) => t.id === state.activeId);
  const tabModels = buildViewerTabModels(state);

  if (!isMobile) return null; // desktop is composed by AgentPanelContent's Group

  // ---------- Mobile (UNCHANGED pill + Sheet) ----------
  const activeKey = {
    id: state.activeId,
    kind: state.activeId === "home" ? "home" : (activeTab?.kind ?? "home"),
  };

  return (
    <>
      <MobilePill viewer={viewer} />

      <Sheet
        open={state.expanded}
        onOpenChange={(open) => {
          if (!open) viewer.collapse();
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          className="flex flex-col p-0"
        >
          <SheetTitle className="sr-only">Commander Viewer</SheetTitle>

          <ViewerTabs
            tabs={tabModels}
            activeKey={activeKey}
            onActivate={(tab) => viewer.activate(tab.id)}
            onClose={(tab) => viewer.close(tab.id)}
            onAdd={() => viewer.activate("home")}
            addLabel="Open viewer home"
            onToggleCollapse={viewer.collapse}
            headerTestId="commander-viewer-tabs"
          />

          <div className="min-h-0 flex-1 overflow-hidden">
            <TabBodySwitch
              activeId={state.activeId}
              activeTab={activeTab}
              companyId={companyId}
              conversationRefs={conversationRefs}
              onOpen={viewer.openRef}
              onCloseTab={viewer.close}
              onOpenTask={onOpenTask}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
