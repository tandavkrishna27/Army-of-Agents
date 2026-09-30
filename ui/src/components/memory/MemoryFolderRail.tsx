import {
  Home, Pin, Inbox, Clock, Archive,
  IdCard, Building2, Target, Zap, PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type ActiveRailKind =
  | "home" | "pinned" | "pending" | "recent" | "archived"
  | "identity" | "domain" | "active_context" | "working"
  | null;

export interface MemoryFolderRailCounts {
  pinned: number;
  pending: number;
  recent: number;
  archived: number;
  identity: number;
  domain: number;
  active_context: number;
  working: number;
}

interface Props {
  counts: MemoryFolderRailCounts;
  activeKind: ActiveRailKind;
  onSelect: (kind: Exclude<ActiveRailKind, null>) => void;
  onExpand?: () => void;
}

const SHORTCUTS = [
  { kind: "home" as const, title: "Home", Icon: Home, countKey: null, brand: false },
  { kind: "pinned" as const, title: "Pinned", Icon: Pin, countKey: "pinned" as const, brand: false },
  { kind: "pending" as const, title: "Pending Review", Icon: Inbox, countKey: "pending" as const, brand: true },
  { kind: "recent" as const, title: "Recent", Icon: Clock, countKey: "recent" as const, brand: false },
  { kind: "archived" as const, title: "Archived", Icon: Archive, countKey: "archived" as const, brand: false },
] as const;

const LAYERS = [
  { kind: "identity" as const, title: "Identity", Icon: IdCard },
  { kind: "domain" as const, title: "Domain", Icon: Building2 },
  { kind: "active_context" as const, title: "Active context", Icon: Target },
  { kind: "working" as const, title: "Working", Icon: Zap },
] as const;

function RailBtn({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "relative flex size-10 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
          : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function MemoryFolderRail({ counts, activeKind, onSelect, onExpand }: Props) {
  return (
    <aside className="flex h-full w-12 shrink-0 flex-col items-center bg-card">
      <div
        className="flex h-[42px] w-full shrink-0 items-center justify-center border-b border-border"
        data-testid="memory-tree-collapsed-header"
      >
        {onExpand && (
          <button
            type="button"
            title="Expand folders"
            aria-label="Expand folders"
            onClick={onExpand}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <PanelLeftOpen className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      <div className="flex flex-1 flex-col items-center gap-1 py-2">
      {SHORTCUTS.map(({ kind, title, Icon, countKey, brand }) => {
        const count = countKey ? counts[countKey] : 0;
        const label = count > 0 ? `${title} (${count})` : title;
        return (
          <RailBtn key={kind} active={activeKind === kind} title={label} onClick={() => onSelect(kind)}>
            <Icon className="size-4" />
            {countKey && count > 0 && (
              <span
                data-badge={kind}
                className={cn(
                  "absolute -right-0.5 -top-0.5 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-1 text-[9px] font-semibold",
                  "shadow-[0_0_0_2px_var(--bg)]",
                  brand ? "bg-brand text-white" : "bg-muted text-foreground",
                )}
              >
                {count}
              </span>
            )}
          </RailBtn>
        );
      })}

      <div className="my-1 h-px w-6 bg-border-soft" />

      {LAYERS.map(({ kind, title, Icon }) => (
        <RailBtn key={kind} active={activeKind === kind} title={title} onClick={() => onSelect(kind)}>
          <Icon className="size-4" />
        </RailBtn>
      ))}
      </div>
    </aside>
  );
}
