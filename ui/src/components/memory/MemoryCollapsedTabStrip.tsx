import {
  FileText,
  Home,
  Image as ImageIcon,
  LayoutGrid,
  ListTree,
  Network,
  PanelRightOpen,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MemoryTab, MemoryTabKind, TabKey } from "../../lib/memoryTabs";

interface Props {
  tabs: ReadonlyArray<MemoryTab>;
  activeKey: TabKey | null;
  onActivate: (id: string, kind: MemoryTabKind) => void;
  onExpand: () => void;
}

const ICON_FOR_KIND: Record<MemoryTabKind, LucideIcon> = {
  home: Home,
  memory_item: FileText,
  asset: ImageIcon,
  graph: Network,
  open: LayoutGrid,
  collection: ListTree,
};

function isActive(tab: MemoryTab, key: TabKey | null): boolean {
  return key !== null && tab.id === key.id && tab.kind === key.kind;
}

/**
 * Shown in place of the horizontal tab bar when the right pane is collapsed.
 * Stacks one icon per open tab vertically; clicking an icon activates the tab
 * (the consumer should also expand the pane on the same click).
 *
 * Top of the strip carries a single "expand pane" button so users can
 * re-open the pane without changing the active tab.
 */
export function MemoryCollapsedTabStrip({ tabs, activeKey, onActivate, onExpand }: Props) {
  return (
    <aside className="flex h-full w-12 shrink-0 flex-col items-center bg-card">
      <div
        className="flex h-[42px] w-full shrink-0 items-center justify-center border-b border-border"
        data-testid="memory-viewer-collapsed-header"
      >
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
      {tabs.map((t) => {
        const active = isActive(t, activeKey);
        const Icon = ICON_FOR_KIND[t.kind];
        return (
          <button
            key={`${t.kind}:${t.id}`}
            type="button"
            title={t.title}
            aria-label={t.title}
            data-tab-id={t.id}
            data-tab-kind={t.kind}
            data-active={active}
            onClick={() => onActivate(t.id, t.kind)}
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
