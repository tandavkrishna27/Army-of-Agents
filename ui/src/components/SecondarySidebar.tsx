import * as React from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";

export type SecondarySidebarItem = {
  id: string;
  label: string;
  count?: number;
  icon?: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
};

export type SecondarySidebarSection = {
  title?: string;
  items: SecondarySidebarItem[];
};

export interface SecondarySidebarProps {
  sections: SecondarySidebarSection[];
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  className?: string;
  /**
   * When true, render as a floating rounded "island" (lobby-tier chrome) instead
   * of the flush right-bordered rail. Opt-in — in-company consumers (TeamLayout,
   * in-company SettingsLayout) leave it false. See design-system §8.1.2.
   */
  floating?: boolean;
  /**
   * Optional panel header shown at the top (matches the app's 42px header
   * convention: `text-[14px] font-semibold tracking-wide`, bottom border). The
   * collapse toggle lives inside this header. Lobby-tier sidebars pass this;
   * without it the legacy top-gap + floating toggle layout is used.
   */
  title?: string;
}

export function SecondarySidebar({
  sections,
  collapsed = false,
  onToggleCollapse,
  className,
  floating = false,
  title,
}: SecondarySidebarProps) {
  const toggleButton = onToggleCollapse ? (
    <button
      type="button"
      onClick={onToggleCollapse}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="size-7 shrink-0 rounded-md text-very-dim hover:bg-white/[0.04] hover:text-text inline-flex items-center justify-center"
    >
      {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
    </button>
  ) : null;

  return (
    <div
      className={cn(
        "relative bg-secondary-sidebar flex flex-col pb-3.5",
        "transition-[width] duration-[180ms]",
        // Legacy top gap only when there's no header row.
        !title && "pt-16",
        floating
          ? "h-[calc(100dvh-1rem)] my-2 ml-2 overflow-hidden rounded-2xl border border-border"
          : "border-r border-border",
        collapsed ? "w-12 px-1" : "w-[200px] px-2",
        className
      )}
      data-collapsed={collapsed}
      role="navigation"
      aria-label="Page navigation"
    >
      {title && (
        <div
          className={cn(
            "flex h-[42px] shrink-0 items-center border-b border-border mb-2",
            // Offset the container padding so the border spans the full width.
            collapsed ? "-mx-1 justify-center px-0" : "-mx-2 justify-between px-3",
          )}
        >
          {!collapsed && (
            <h2 className="text-[14px] font-semibold tracking-wide truncate">{title}</h2>
          )}
          {toggleButton}
        </div>
      )}

      {sections.map((section, idx) => (
        <div
          key={section.title ?? String(idx)}
          className={cn(idx > 0 && "mt-2 pt-2 border-t border-border-soft")}
        >
          {!collapsed && section.title && (
            <div className="text-[0.62rem] uppercase tracking-[0.1em] text-very-dim px-2.5 py-1 mb-1 font-semibold">
              {section.title}
            </div>
          )}
          {section.items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={item.onClick}
              title={collapsed ? item.label : undefined}
              data-active={item.active ? "true" : undefined}
              className={cn(
                "relative w-full grid items-center gap-2 px-2.5 py-2 rounded-md text-sm transition-colors",
                collapsed ? "grid-cols-[20px] justify-center" : "grid-cols-[1fr_auto]",
                item.active
                  ? "bg-brand/[0.08] text-sidebar-active-text"
                  : "text-text/[0.78] hover:bg-white/[0.04] hover:text-text",
              )}
            >
              {collapsed ? (
                <span className="text-current inline-flex items-center justify-center [&_svg]:size-4">
                  {item.icon ?? item.label.charAt(0).toUpperCase()}
                </span>
              ) : (
                <>
                  <span className="text-left flex items-center gap-2 [&_svg]:size-4">
                    {item.icon}
                    {item.label}
                  </span>
                  {item.count !== undefined && (
                    <span
                      className={cn(
                        "font-mono text-[0.68rem] text-very-dim",
                        item.active && "text-sidebar-active-text/80"
                      )}
                    >
                      {item.count}
                    </span>
                  )}
                </>
              )}
              {item.active && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]",
                    collapsed ? "right-1.5 top-1.5" : "right-2.5 top-1/2 -translate-y-1/2",
                  )}
                />
              )}
            </button>
          ))}
        </div>
      ))}

      {/* Legacy floating toggle for headerless (in-company) usage. */}
      {!title && toggleButton && (
        <div className="absolute right-2 top-3">{toggleButton}</div>
      )}
    </div>
  );
}
