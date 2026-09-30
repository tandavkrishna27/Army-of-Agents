import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";

interface SidebarCollapseToggleProps {
  collapsed: boolean;
  onToggle: () => void;
  /**
   * Anchor — the LEFT offset where the button visually centers on the sidebar
   * border. Pass the current sidebar width; the button positions itself half
   * over (sidebarWidth - 13px) so it straddles the border between sidebar and
   * main content.
   */
  sidebarWidth: number;
  /**
   * Top offset — defaults to 9px so the button vertically centers in the
   * sidebar's 44px header row, aligned with the page header.
   */
  top?: number;
  className?: string;
  /**
   * Optional aria-label/title override. Defaults to "Expand sidebar" /
   * "Collapse sidebar". Override when the toggle controls a non-primary
   * sidebar (e.g. the SettingsLayout secondary nav) so screen readers and
   * tests can disambiguate which toggle they're targeting.
   */
  ariaLabel?: string;
}

export function SidebarCollapseToggle({
  collapsed,
  onToggle,
  sidebarWidth,
  top = 9,
  className,
  ariaLabel,
}: SidebarCollapseToggleProps) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const label = ariaLabel ?? (collapsed ? "Expand sidebar" : "Collapse sidebar");
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      className={cn(
        "absolute inline-flex items-center justify-center rounded-md",
        // Collapsed: a larger control lifted above the adjacent content rail
        // (e.g. the Inbox hub lane rail) so the "Expand" affordance is findable
        // and never visually absorbed into a neighbouring 56px icon rail.
        collapsed ? "z-30 size-8" : "z-10 size-[26px]",
        "border border-border-strong bg-card-2 text-very-dim",
        "shadow-[0_2px_6px_rgba(0,0,0,0.4)]",
        "transition-[background,color,border-color,transform] duration-[120ms]",
        "hover:scale-105 hover:border-brand hover:bg-card hover:text-text",
        "focus-visible:outline-none focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand-focus-ring",
        className,
      )}
      style={{ top, left: `calc(${sidebarWidth}px - ${collapsed ? 16 : 13}px)` }}
    >
      <Icon className={collapsed ? "size-4" : "size-3.5"} />
    </button>
  );
}
