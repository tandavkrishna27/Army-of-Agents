import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { TaskDetail } from "@/components/TaskDetail";
import { ThreadDetail } from "@/pages/ThreadDetail";
import { ApprovalDetailCore } from "@/components/approval/ApprovalDetailCore";
import { BrowserViewer } from "@/components/viewers/BrowserViewer";
import { BudgetCapsSection } from "@/components/settings/sections/BudgetCapsSection";
import type { HubItemListRow } from "@/api/hub-items";
import type { IssueContextBundle } from "@/api/issues";
import { TaskOutputViewer } from "../threads/TaskOutputViewer";
import { AgentDetailContainer } from "../agent-detail/AgentDetailContainer";
import { RunDetailContainer } from "../agent-detail/RunDetailContainer";
import { HUB_TABPANEL_ID } from "./HubTabStrip";
import { RuntimeDecisionPanel } from "./RuntimeDecisionPanel";
import { WorkQuestionPanel } from "@/components/work-questions/WorkQuestionPanel";
import { GenericNotificationBody } from "./viewers/GenericNotificationBody";
import { JoinRequestBody } from "./viewers/JoinRequestBody";
import { MarketplaceOpBody } from "./viewers/MarketplaceOpBody";
import { ReminderBody } from "./viewers/ReminderBody";
import { RoutineBody } from "./viewers/RoutineBody";
import { SuggestionBody } from "./viewers/SuggestionBody";
import { UnlinkableEntityBody } from "./viewers/UnlinkableEntityBody";
import {
  browserTab,
  taskTab,
  type HubAgentPayload,
  type HubApprovalPayload,
  type HubBrowserPayload,
  type HubRunPayload,
  type HubRuntimeDecisionPayload,
  type HubWorkQuestionPayload,
  type HubTab,
  type HubTabKind,
  type HubTaskPayload,
  type HubThreadPayload,
} from "./hubViewerModel";

interface HubTabBodyProps {
  tab: HubTab;
  companyId: string | undefined;
  onOpenTab: (tab: HubTab) => void;
  /**
   * Resolves a hub item id back to its full {@link HubItemListRow}. The
   * runtime_decision tab payload only carries `{ hubItemId }`, but
   * {@link RuntimeDecisionPanel} needs the full row. The parent (E2/G1) supplies
   * this; when absent, the runtime_decision tab falls back to a placeholder.
   */
  resolveHubItem?: (hubItemId: string) => HubItemListRow | undefined;
  /**
   * The active tab's resolved hub row. Placeholder viewer payloads often carry
   * source ids instead of hub-item ids, so these content bodies render from the
   * row the shell already resolved for the action bar.
   */
  activeItem?: HubItemListRow | null;
  /**
   * Body for the non-closeable `home` tab. HubShell supplies the real
   * {@link HubHome}; when absent the built-in placeholder renders.
   */
  homeContent?: ReactNode;
}

/**
 * Renders the body for the active hub tab. The root always carries the
 * {@link HUB_TABPANEL_ID} + `role="tabpanel"` so the tab chrome's
 * `aria-controls` resolves, and it fills the panel fluidly (`w-full h-full`)
 * rather than the legacy fixed 360px HubViewer aside (A2 review).
 *
 * Live-wired kinds: home, task, task_output, thread, approval, browser,
 * budget, agent, run, runtime_decision, and row-backed content bodies for
 * join_request, suggestion, marketplace_op, reminder, routine, artifact,
 * memory, and generic notification when `activeItem` is available. Missing row
 * context falls back to {@link TabLoadingPlaceholder} -- never to `null`. */
export function HubTabBody({
  tab,
  companyId,
  onOpenTab,
  resolveHubItem,
  activeItem,
  homeContent,
}: HubTabBodyProps) {
  return (
    <div
      id={HUB_TABPANEL_ID}
      role="tabpanel"
      className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-testid="hub-tab-body"
      data-tab-kind={tab.kind}
    >
      <HubTabBodyContent
        tab={tab}
        companyId={companyId}
        onOpenTab={onOpenTab}
        resolveHubItem={resolveHubItem}
        activeItem={activeItem}
        homeContent={homeContent}
      />
    </div>
  );
}

function HubTabBodyContent({
  tab,
  companyId,
  onOpenTab,
  resolveHubItem,
  activeItem,
  homeContent,
}: HubTabBodyProps) {
  switch (tab.kind) {
    case "home":
      return <>{homeContent ?? <HubHomePlaceholder />}</>;

    case "thread": {
      const payload = tab.payload as HubThreadPayload | undefined;
      if (!payload) return <TabLoadingPlaceholder kind={tab.kind} />;
      // D2: host the full ThreadDetail by prop id + company. `embedded` drops
      // the page chrome (left rail, breadcrumbs) but keeps the thread fully live.
      // `onOpenTab` is intentionally NOT threaded: ThreadDetail opens its
      // internal links in its own right-side viewer, so thread-internal links do
      // not (yet) spawn sibling hub tabs. Wiring that hand-off is a later phase.
      return (
        <ThreadDetail
          discussionId={payload.discussionId}
          companyId={companyId}
          embedded
        />
      );
    }

    case "task": {
      const payload = tab.payload as HubTaskPayload | undefined;
      if (!payload) return <TabLoadingPlaceholder kind={tab.kind} />;
      return (
        <TaskDetail
          issueId={payload.issueId}
          active
          onOpenScopeHandoffItem={(item) => handleTaskHandoff(item, onOpenTab)}
        />
      );
    }

    case "task_output": {
      const payload = tab.payload as HubTaskPayload | undefined;
      if (!payload) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <TaskOutputViewer issueId={payload.issueId} embedded />;
    }

    case "approval": {
      const payload = tab.payload as HubApprovalPayload | undefined;
      if (!payload) return <TabLoadingPlaceholder kind={tab.kind} />;
      // D3: host the full approval body by prop id. `embedded` drops route/page
      // couplings (company route-sync, breadcrumbs, `?resolved=approved` banner,
      // post-action navigation); `onOpenTab` lets linked task / hired agent
      // links spawn sibling hub tabs instead of navigating away.
      return (
        <ApprovalDetailCore
          approvalId={payload.approvalId}
          embedded
          onOpenTab={onOpenTab}
        />
      );
    }

    case "browser": {
      const payload = tab.payload as HubBrowserPayload | undefined;
      return <BrowserViewer key={tab.key} initialUrl={payload?.url ?? "about:blank"} />;
    }

    case "budget":
      return <BudgetCapsSection />;

    case "agent": {
      // D4a: host the full agent-detail chrome by prop id. The container
      // replicates the route page's data orchestration (useAgentDetailData) but
      // drops route-only chrome (breadcrumbs, URL tab routing, unsaved-changes
      // cross-page guard).
      const payload = tab.payload as HubAgentPayload | undefined;
      if (!payload) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <AgentDetailContainer agentId={payload.agentId} companyId={companyId} />;
    }

    case "run": {
      // D4b: host a single heartbeat run by prop id. The payload carries BOTH
      // runId + agentId (no fetch-by-id endpoint for a run), so the container
      // fetches the agent's run list and finds the row.
      const payload = tab.payload as HubRunPayload | undefined;
      if (!payload) return <TabLoadingPlaceholder kind={tab.kind} />;
      return (
        <RunDetailContainer
          runId={payload.runId}
          agentId={payload.agentId}
          companyId={companyId}
          onOpenIssue={(issueId, title) => onOpenTab(taskTab(issueId, title))}
        />
      );
    }

    case "notification":
      return activeItem ? (
        <GenericNotificationBody item={activeItem} />
      ) : (
        <HubNotificationBody tab={tab} />
      );

    case "runtime_decision": {
      // The runtime_decision tab payload only carries `{ hubItemId }`, but
      // RuntimeDecisionPanel needs the full HubItemListRow. The parent supplies
      // `resolveHubItem` (E2/G1); until then, fall back to the placeholder.
      const payload = tab.payload as HubRuntimeDecisionPayload | undefined;
      const item = payload && resolveHubItem ? resolveHubItem(payload.hubItemId) : undefined;
      if (!item) return <TabLoadingPlaceholder kind={tab.kind} />;
      return (
        <div className="h-full w-full overflow-auto p-5" data-testid="hub-runtime-decision-body">
          <RuntimeDecisionPanel item={item} />
        </div>
      );
    }

    case "work_question": {
      const payload = tab.payload as HubWorkQuestionPayload | undefined;
      if (!payload || !companyId) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <WorkQuestionPanel companyId={companyId} questionId={payload.questionId} embedded />;
    }

    case "join_request":
      return activeItem ? (
        <JoinRequestBody item={activeItem} />
      ) : (
        <TabLoadingPlaceholder kind={tab.kind} />
      );

    case "suggestion":
      return activeItem ? (
        <SuggestionBody item={activeItem} />
      ) : (
        <TabLoadingPlaceholder kind={tab.kind} />
      );

    case "reminder":
      return activeItem ? (
        <ReminderBody item={activeItem} />
      ) : (
        <TabLoadingPlaceholder kind={tab.kind} />
      );

    case "marketplace_op":
      return activeItem ? (
        <MarketplaceOpBody item={activeItem} />
      ) : (
        <TabLoadingPlaceholder kind={tab.kind} />
      );

    case "routine":
      return activeItem ? (
        <RoutineBody item={activeItem} />
      ) : (
        <TabLoadingPlaceholder kind={tab.kind} />
      );

    case "artifact":
      return activeItem ? (
        <UnlinkableEntityBody item={activeItem} kind="artifact" />
      ) : (
        <TabLoadingPlaceholder kind={tab.kind} />
      );

    case "memory":
      return activeItem ? (
        <UnlinkableEntityBody item={activeItem} kind="memory" />
      ) : (
        <TabLoadingPlaceholder kind={tab.kind} />
      );

    default:
      // Exhaustiveness guard: any new kind falls back to a placeholder, never null.
      return <TabLoadingPlaceholder kind={(tab as HubTab).kind} />;
  }
}

/**
 * Re-emit a task's scope-handoff item as a hub tab. Mirrors ThreadViewer's
 * task-branch handoff (ThreadViewer.tsx ~355-380). The hub model only exposes a
 * browser tab factory today, so URL handoffs open a browser tab; artifact/asset
 * handoffs are no-ops until hub artifact/asset tabs exist (Phase D/E).
 */
function handleTaskHandoff(
  item: IssueContextBundle["items"][number],
  onOpenTab: (tab: HubTab) => void,
) {
  const metadata =
    item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? (item.metadata as Record<string, unknown>)
      : {};
  const label = item.label || item.itemType.replaceAll("_", " ");
  const url = typeof metadata.url === "string" && metadata.url.trim().length > 0 ? metadata.url : null;
  if (item.itemType === "url" && url) {
    onOpenTab(browserTab(url, label));
  }
}

/** Placeholder home body. E2 replaces this with the real HubHome. */
function HubHomePlaceholder() {
  return (
    <div
      className="flex h-full w-full items-center justify-center p-6 text-center"
      data-testid="hub-home-placeholder"
    >
      <div className="max-w-xs">
        <p className="text-sm font-medium text-foreground">Inbox home</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Your attention and decision queue will render here.
        </p>
      </div>
    </div>
  );
}

/** Minimal generic body for notification tabs (rich body relocated from HubViewer in E2). */
function HubNotificationBody({ tab }: { tab: HubTab }) {
  return (
    <div className="h-full w-full overflow-auto p-6" data-testid="hub-notification-body">
      <h2 className="text-lg font-semibold leading-snug text-foreground">{tab.title}</h2>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        No dedicated viewer for this item yet. Open it from the list to review details.
      </p>
    </div>
  );
}

/**
 * Shown for tab kinds whose dedicated viewer is not wired yet, so the tab chrome
 * + panel still render. Never returns `null`.
 */
export function TabLoadingPlaceholder({ kind }: { kind?: HubTabKind }) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center"
      data-testid="hub-tab-loading-placeholder"
      role="status"
    >
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
      <div>
        <p className="text-sm font-medium text-foreground">Preparing viewer…</p>
        {kind ? (
          <p className="mt-1 text-xs text-muted-foreground">
            A dedicated <span className="font-mono">{kind}</span> viewer is coming soon.
          </p>
        ) : null}
      </div>
    </div>
  );
}
