import { useRef } from "react";
import {
  Activity,
  Bot,
  CheckSquare,
  CircleHelp,
  DollarSign,
  FileText,
  Globe,
  Home,
  Lightbulb,
  MessageSquare,
  PanelRightOpen,
  Plus,
  Rocket,
  ShieldQuestion,
  Sparkles,
  Timer,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { HubTab, HubTabKind } from "./hubViewerModel";
import { HUB_TABS_MAX } from "./useHubTabs";

/** Id of the viewer body panel each tab controls (for `aria-controls`). */
export const HUB_TABPANEL_ID = "hub-tabpanel";

/** Icon per tab kind. Keyed on {@link HubTabKind}, not on semantic type. */
export const KIND_ICON: Record<HubTabKind, LucideIcon> = {
  home: Home,
  browser: Globe,
  approval: ShieldQuestion,
  join_request: UserPlus,
  thread: MessageSquare,
  runtime_decision: Bot,
  work_question: CircleHelp,
  task: CheckSquare,
  task_output: FileText,
  agent: Bot,
  run: Activity,
  artifact: FileText,
  memory: Sparkles,
  budget: DollarSign,
  suggestion: Lightbulb,
  marketplace_op: Sparkles,
  reminder: Timer,
  routine: Rocket,
  notification: Sparkles,
};

interface HubTabStripProps {
  tabs: HubTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onAddBrowser: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function HubTabStrip({
  tabs,
  activeKey,
  onActivate,
  onClose,
  onAddBrowser,
  collapsed = false,
  onToggleCollapse,
}: HubTabStripProps) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  if (collapsed) {
    return (
      <HubCollapsedTabStrip
        tabs={tabs}
        activeKey={activeKey}
        onActivate={onActivate}
        onExpand={onToggleCollapse}
      />
    );
  }

  function handleClose(key: string) {
    // Compute the tab that will become active after this one closes, so we can
    // move focus there (mirrors the ViewerTabs / thread-strip focus handling).
    const index = tabs.findIndex((tab) => tab.key === key);
    const remaining = tabs.filter((tab) => tab.key !== key);
    const nextActive =
      key === activeKey
        ? remaining[index]?.key ?? remaining[index - 1]?.key ?? remaining.at(-1)?.key ?? null
        : activeKey;
    onClose(key);
    if (nextActive) {
      // Focus after the parent re-renders with the updated tab set.
      requestAnimationFrame(() => tabRefs.current.get(nextActive)?.focus());
    }
  }

  return (
    <div
      className="flex h-[42px] shrink-0 items-center border-b border-border bg-card px-2"
      data-testid="hub-tab-strip"
    >
      <div
        role="tablist"
        aria-label="Open hub tabs"
        className="flex min-w-0 flex-1 overflow-x-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
      >
        {tabs.map((tab) => {
          const active = tab.key === activeKey;
          const Icon = KIND_ICON[tab.kind];
          const closeable = tab.closeable !== false;
          return (
            <button
              key={tab.key}
              ref={(node) => {
                if (node) tabRefs.current.set(tab.key, node);
                else tabRefs.current.delete(tab.key);
              }}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={HUB_TABPANEL_ID}
              tabIndex={active ? 0 : -1}
              data-tab-id={tab.key}
              data-tab-kind={tab.kind}
              data-active={active}
              title={tab.title}
              onClick={() => onActivate(tab.key)}
              className={cn(
                "group relative inline-flex h-[30px] max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-border pl-2.5 pr-2 text-xs",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-focus-ring",
                active
                  ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
                  : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )}
            >
              <Icon className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{tab.title}</span>
              {closeable && (
                <span
                  role="button"
                  aria-label={`Close ${tab.title}`}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleClose(tab.key);
                  }}
                  className={cn(
                    "ml-1 inline-flex rounded p-0.5 transition-opacity",
                    active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                    "hover:bg-white/[0.08]",
                  )}
                >
                  <X className="size-3" aria-hidden />
                </span>
              )}
              {active && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-1.5 top-1/2 size-[5px] -translate-y-1/2 rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
                />
              )}
            </button>
          );
        })}
        <button
          type="button"
          title="Open browser tab"
          aria-label="Open browser tab"
          onClick={onAddBrowser}
          className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <Plus className="size-3.5" aria-hidden />
        </button>
      </div>
      {tabs.length >= HUB_TABS_MAX ? (
        <span
          className="ml-2 shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground"
          title={`Tab limit reached: the oldest tab is closed when you open a new one (max ${HUB_TABS_MAX}).`}
          data-testid="hub-tab-cap"
        >
          {HUB_TABS_MAX} max
        </span>
      ) : null}
    </div>
  );
}

interface HubCollapsedTabStripProps {
  tabs: HubTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onExpand?: () => void;
}

function HubCollapsedTabStrip({
  tabs,
  activeKey,
  onActivate,
  onExpand,
}: HubCollapsedTabStripProps) {
  return (
    <aside
      className="flex h-full w-[46px] shrink-0 flex-col items-center bg-card"
      data-testid="hub-tab-strip-collapsed"
    >
      <div className="flex h-[42px] w-full shrink-0 items-center justify-center border-b border-border">
        <button
          type="button"
          title="Expand tabs"
          aria-label="Expand tabs"
          onClick={onExpand}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <PanelRightOpen className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center gap-1 py-2">
        {tabs.map((tab) => {
          const Icon = KIND_ICON[tab.kind];
          const active = tab.key === activeKey;
          return (
            <button
              key={tab.key}
              type="button"
              title={tab.title}
              aria-label={tab.title}
              data-tab-id={tab.key}
              data-tab-kind={tab.kind}
              data-active={active}
              onClick={() => {
                onActivate(tab.key);
                onExpand?.();
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
