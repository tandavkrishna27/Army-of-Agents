import { List, Table2, LayoutGrid, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MemoryViewMode } from "../../hooks/useMemoryViewMode";

interface Props {
  mode: MemoryViewMode;
  onChange: (mode: MemoryViewMode) => void;
}

interface Item {
  mode: MemoryViewMode;
  Icon: LucideIcon;
  title: string;
}

const ITEMS: ReadonlyArray<Item> = [
  { mode: "list", Icon: List, title: "List view" },
  { mode: "table", Icon: Table2, title: "Table view" },
  { mode: "cards", Icon: LayoutGrid, title: "Cards view" },
];

/**
 * Three-icon mutually-exclusive selector for the center-pane view mode. Uses
 * the radiogroup ARIA pattern (exactly one is always selected). Roving-tabindex
 * arrow-key navigation is deferred — Tab still moves between the buttons one
 * at a time.
 */
export function MemoryViewToggle({ mode, onChange }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Center pane view mode"
      className="inline-flex overflow-hidden rounded-md border border-border-strong"
    >
      {ITEMS.map(({ mode: m, Icon, title }, i) => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            title={title}
            aria-checked={active}
            onClick={() => {
              if (!active) onChange(m);
            }}
            className={cn(
              // h-6 (24px) meets WCAG 2.5.8 minimum target size on the
              // shorter axis. Width stays compact for the toolbar.
              "flex h-6 w-7 items-center justify-center transition-colors",
              i > 0 && "border-l border-border",
              active
                ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
                : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
