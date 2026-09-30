import { CheckSquare, Compass, FileText, Globe, LayoutGrid, MessageSquare, Network, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrowserViewer } from "../viewers/BrowserViewer";
import { ViewerTabs, type ViewerTabModel } from "../viewers/ViewerTabs";
import {
  OPEN_TAB_KEY,
  browserTab,
  createGlobalMapTab,
  createOpenTab,
  type ThreadViewerBrowserPayload,
  type ThreadViewerMapPayload,
  type ThreadViewerTab,
  type ThreadViewerTabKind,
} from "./threadViewerModel";

const HOME_VIEWER_ICON_FOR_KIND: Record<ThreadViewerTabKind, typeof LayoutGrid> = {
  open: LayoutGrid,
  scope_item: FileText,
  task: FileText,
  task_output: FileText,
  memory: FileText,
  artifact_ref: FileText,
  asset: FileText,
  artifact: FileText,
  browser: Globe,
  map: Network,
  discussion: MessageSquare,
  approval: CheckSquare,
  output_ref: Package,
};

export const HOME_VIEWER_DEFAULT_TAB = createGlobalMapTab();

interface ThreadsGlobalViewerProps {
  tabs: ThreadViewerTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onOpenTab: (tab: ThreadViewerTab) => void;
  onToggleCollapse: () => void;
  width: number;
}

export function ThreadsGlobalViewer({
  tabs,
  activeKey,
  onActivate,
  onClose,
  onOpenTab,
  onToggleCollapse,
  width,
}: ThreadsGlobalViewerProps) {
  const activeTab = activeKey ? tabs.find((tab) => tab.key === activeKey) ?? null : null;
  const viewerTabs: ViewerTabModel[] = tabs.map((tab) => ({
    id: tab.key,
    kind: tab.kind,
    title: tab.label,
    closeable: tab.closeable,
    icon: HOME_VIEWER_ICON_FOR_KIND[tab.kind],
  }));

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-[width] duration-200"
      style={{ width }}
      data-testid="threads-global-viewer"
      data-collapsed="false"
      data-width={String(width)}
    >
      <ViewerTabs
        tabs={viewerTabs}
        activeKey={activeTab ? { id: activeTab.key, kind: activeTab.kind } : null}
        onActivate={(tab) => onActivate(tab.id)}
        onClose={(tab) => onClose(tab.id)}
        onAdd={() => onOpenTab(createOpenTab())}
        addLabel="Open viewer tab"
        onToggleCollapse={onToggleCollapse}
        tabListLabel="Open discussion home viewer tabs"
        headerTestId="thread-viewer-header"
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab ? (
          <ThreadsGlobalViewerBody tab={activeTab} onOpenTab={onOpenTab} />
        ) : (
          <ThreadsGlobalViewerEmpty onOpen={() => onOpenTab(createOpenTab())} />
        )}
      </div>
    </aside>
  );
}

function ThreadsGlobalViewerBody({
  tab,
  onOpenTab,
}: {
  tab: ThreadViewerTab;
  onOpenTab: (tab: ThreadViewerTab) => void;
}) {
  if (tab.key === OPEN_TAB_KEY || tab.kind === "open") {
    return <ThreadsGlobalOpenViewer onOpenTab={onOpenTab} />;
  }

  if (tab.kind === "browser") {
    const payload = tab.payload as ThreadViewerBrowserPayload | undefined;
    return <BrowserViewer key={tab.key} initialUrl={payload?.url ?? "about:blank"} />;
  }

  if (tab.kind === "map") {
    const payload = tab.payload as ThreadViewerMapPayload | undefined;
    const isGlobal = payload?.scope !== "thread";
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-5" data-testid="thread-map-placeholder">
        <div className="w-full max-w-sm rounded-md border border-border bg-muted/20 p-4 text-center">
          <Network className="mx-auto mb-3 h-6 w-6 text-muted-foreground" aria-hidden />
          <div className="text-sm font-semibold">{isGlobal ? "Global map" : "Thread map"}</div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {isGlobal
              ? "The global discussions relationship map will be wired here later."
              : "Thread relationship map will be wired here later."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 items-center justify-center p-5">
      <div className="text-center text-xs text-muted-foreground">This viewer tab is not available on Home yet.</div>
    </div>
  );
}

function ThreadsGlobalOpenViewer({ onOpenTab }: { onOpenTab: (tab: ThreadViewerTab) => void }) {
  return (
    <div className="h-full min-h-0 overflow-auto p-3" data-testid="threads-home-open-viewer">
      <div className="space-y-3">
        <section className="rounded-md border border-border/70 bg-card/50 p-2.5">
          <div className="mb-2 flex items-center gap-2">
            <Network className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <h3 className="min-w-0 flex-1 text-xs font-semibold">Map</h3>
          </div>
          <button
            type="button"
            onClick={() => onOpenTab(createGlobalMapTab())}
            className="flex w-full min-w-0 items-center gap-2 rounded-md border border-border/70 bg-background px-2 py-2 text-left transition-colors hover:bg-muted/50"
          >
            <Network className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">Global map</span>
              <span className="block truncate text-[10px] text-muted-foreground">All discussion relationships</span>
            </span>
          </button>
        </section>

        <section className="rounded-md border border-border/70 bg-card/50 p-2.5">
          <div className="mb-2 flex items-center gap-2">
            <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <h3 className="min-w-0 flex-1 text-xs font-semibold">Browser</h3>
          </div>
          <button
            type="button"
            onClick={() => onOpenTab(browserTab("about:blank", "Browser"))}
            className="flex w-full min-w-0 items-center gap-2 rounded-md border border-border/70 bg-background px-2 py-2 text-left transition-colors hover:bg-muted/50"
          >
            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">New browser</span>
              <span className="block truncate text-[10px] text-muted-foreground">Open a URL in this viewer</span>
            </span>
          </button>
        </section>
      </div>
    </div>
  );
}

function ThreadsGlobalViewerEmpty({ onOpen }: { onOpen: () => void }) {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center p-6"
      data-testid="thread-viewer-empty"
    >
      <div className="max-w-xs text-center">
        <Compass className="mx-auto mb-3 h-5 w-5 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium text-foreground">No viewer tab open</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Open maps or a browser from discussions home.
        </p>
        <Button type="button" variant="outline" size="sm" className="mt-4 h-8 text-xs" onClick={onOpen}>
          Open
        </Button>
      </div>
    </div>
  );
}
