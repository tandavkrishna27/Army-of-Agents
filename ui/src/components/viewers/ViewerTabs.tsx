import { PanelRightClose, Plus, X } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

export interface ViewerTabModel {
  id: string;
  kind: string;
  title: string;
  icon?: ComponentType<{ className?: string }>;
  closeable?: boolean;
}

export interface ViewerTabKey {
  id: string;
  kind: string;
}

interface ViewerTabsProps {
  tabs: ReadonlyArray<ViewerTabModel>;
  activeKey: ViewerTabKey | null;
  onActivate: (tab: ViewerTabModel) => void;
  onClose?: (tab: ViewerTabModel) => void;
  onAdd?: () => void;
  addLabel?: string;
  onToggleCollapse?: () => void;
  tabListLabel?: string;
  headerTestId?: string;
}

function isActive(tab: ViewerTabModel, key: ViewerTabKey | null): boolean {
  return key !== null && tab.id === key.id && tab.kind === key.kind;
}

export function ViewerTabs({
  tabs,
  activeKey,
  onActivate,
  onClose,
  onAdd,
  addLabel = "New viewer tab",
  onToggleCollapse,
  tabListLabel = "Open viewer tabs",
  headerTestId = "viewer-tabs-header",
}: ViewerTabsProps) {
  return (
    <div
      className="flex h-[42px] shrink-0 items-center border-b border-border bg-card px-2"
      data-testid={headerTestId}
    >
      <div
        role="tablist"
        aria-label={tabListLabel}
        className="flex min-w-0 flex-1 overflow-x-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
      >
        {tabs.map((tab) => {
          const active = isActive(tab, activeKey);
          const Icon = tab.icon;
          const closeable = tab.closeable !== false && Boolean(onClose);
          return (
            <div
              key={`${tab.kind}:${tab.id}`}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-tab-id={tab.id}
              data-tab-kind={tab.kind}
              data-active={active}
              onClick={() => onActivate(tab)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onActivate(tab);
                }
              }}
              className={cn(
                "group relative inline-flex h-[30px] max-w-[220px] cursor-pointer items-center gap-1.5 border-r border-border pl-2.5 pr-2 text-xs",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-focus-ring",
                active
                  ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
                  : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )}
            >
              {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
              <span className="truncate">{tab.title}</span>
              {closeable && (
                <button
                  type="button"
                  data-slot="close"
                  aria-label={`Close ${tab.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose?.(tab);
                  }}
                  className={cn(
                    "ml-1 rounded p-0.5 transition-opacity",
                    active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                    "hover:bg-white/[0.08]",
                  )}
                >
                  <X className="size-3" aria-hidden />
                </button>
              )}
              {active && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-1.5 top-1/2 size-[5px] -translate-y-1/2 rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
                />
              )}
            </div>
          );
        })}
        {onAdd && (
          <button
            type="button"
            title={addLabel}
            aria-label={addLabel}
            onClick={onAdd}
            className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      {onToggleCollapse && (
        <button
          type="button"
          title="Hide preview"
          aria-label="Hide preview"
          onClick={onToggleCollapse}
          className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <PanelRightClose className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
