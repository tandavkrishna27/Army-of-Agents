import { Bell, Home, Inbox, Lightbulb, Mail, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { HubLane } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

export type HubRailLane = HubLane | null;

interface HubRailProps {
  activeLane: HubRailLane;
  counts: { open: number; unread: number };
  visibleLanes?: HubLane[];
  onLaneChange: (lane: HubRailLane) => void;
  /** Icon-only mode (mirrors the Discussions thread rail). */
  collapsed?: boolean;
  /** When provided, the 42px header shows the collapse/expand chevron. */
  onToggleCollapsed?: () => void;
}

const lanes: Array<{
  lane: HubRailLane;
  label: string;
  icon: typeof Home;
}> = [
  { lane: null, label: "Home", icon: Home },
  { lane: "waiting_on_you", label: "Waiting on you", icon: Inbox },
  { lane: "notifications", label: "Notifications", icon: Bell },
  { lane: "suggestions", label: "Suggestions", icon: Lightbulb },
];

/**
 * The hub's lane rail — a floating island panel matching the Discussions
 * thread rail: 42px header (uppercase label + PanelLeft toggle), expanded rows
 * with icon + label + count, collapsible to an icon-only column.
 */
export function HubRail({
  activeLane,
  counts,
  visibleLanes,
  onLaneChange,
  collapsed = false,
  onToggleCollapsed,
}: HubRailProps) {
  const visibleRailLanes = lanes.filter(
    ({ lane }) => lane === null || !visibleLanes || visibleLanes.includes(lane),
  );

  return (
    <nav
      aria-label="Hub lanes"
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "flex h-full shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-[width] duration-200",
        collapsed ? "w-12" : "w-[200px]",
      )}
    >
      {/* 42px header — matches the Discussions thread-rail header exactly. */}
      <div
        className={cn(
          "flex h-[42px] shrink-0 items-center gap-1 border-b border-border",
          collapsed ? "justify-center px-1" : "px-2",
        )}
        data-testid="hub-rail-header"
      >
        {!collapsed && (
          <span className="flex-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Inbox
          </span>
        )}
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand hub lanes" : "Collapse hub lanes"}
            title={collapsed ? "Expand hub lanes" : "Collapse hub lanes"}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {collapsed ? (
          <div className="flex flex-col items-center gap-1.5 pt-1">
            {visibleRailLanes.map(({ lane, label, icon: Icon }) => {
              const active = activeLane === lane;
              return (
                <button
                  key={label}
                  type="button"
                  aria-label={label}
                  aria-pressed={active}
                  title={label}
                  onClick={() => onLaneChange(lane)}
                  className={cn(
                    "relative inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {lane === "waiting_on_you" && counts.open > 0 ? (
                    <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-brand px-1 text-[10px] leading-4 text-white">
                      {counts.open}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="space-y-1.5">
            {visibleRailLanes.map(({ lane, label, icon: Icon }) => {
              const active = activeLane === lane;
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onLaneChange(lane)}
                  className={cn(
                    "group flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground/80 hover:bg-white/[0.04] hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {lane === "waiting_on_you" && counts.open > 0 ? (
                    <span className="ml-auto shrink-0 rounded-full bg-brand px-1.5 text-[10px] leading-4 text-white">
                      {counts.open}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-2">
        {collapsed ? (
          <button
            type="button"
            aria-label="Mail reserved"
            title="Mail reserved"
            disabled
            className="mx-auto flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground opacity-40"
          >
            <Mail className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Mail reserved"
            title="Mail reserved"
            disabled
            className="flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium text-muted-foreground opacity-40"
          >
            <Mail className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Mail</span>
          </button>
        )}
      </div>
    </nav>
  );
}
