import { Link, NavLink, useLocation } from "@/lib/router";
import { cn } from "../lib/utils";
import { useSidebar } from "../context/SidebarContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCompany } from "../context/CompanyContext";
import type { LucideIcon } from "lucide-react";

interface SidebarNavItemProps {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  className?: string;
  badge?: number;
  badgeTone?: "default" | "danger";
  alert?: boolean;
  liveCount?: number;
  collapsed?: boolean;
  /** Skip company-prefix injection — use `to` as the absolute path. */
  noPrefix?: boolean;
}

export function SidebarNavItem({
  to,
  label,
  icon: Icon,
  end,
  className,
  badge,
  badgeTone = "default",
  alert = false,
  liveCount,
  collapsed,
  noPrefix = false,
}: SidebarNavItemProps) {
  const { isMobile, setSidebarOpen } = useSidebar();
  const { selectedCompany } = useCompany();
  const prefix = selectedCompany?.issuePrefix ?? "";
  const fullPath = noPrefix ? to : `/${prefix}${to}`;
  const location = useLocation();
  const isActive = end
    ? location.pathname === fullPath
    : location.pathname.startsWith(fullPath);

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={fullPath}
            onClick={() => { if (isMobile) setSidebarOpen(false); }}
            className={cn(
              "relative flex items-center justify-center size-9 rounded-md transition-colors mx-auto",
              isActive
                ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
                : "text-foreground/[0.78] hover:bg-white/[0.04] hover:text-foreground",
              className,
            )}
          >
            <span className="relative shrink-0">
              <Icon className="size-4 transition-colors duration-150" />
              {alert && (
                <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-red-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
              )}
              {!alert && badge != null && badge > 0 && (
                <span
                  className={cn(
                    "absolute -right-0.5 -top-0.5 size-2 rounded-full shadow-[0_0_0_2px_hsl(var(--background))]",
                    badgeTone === "danger" ? "bg-red-500" : "bg-primary",
                  )}
                />
              )}
              {!alert && (badge == null || badge <= 0) && liveCount != null && liveCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-blue-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
              )}
            </span>
            {isActive && (
              <span
                aria-hidden
                className="pointer-events-none absolute right-1.5 top-1.5 size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
              />
            )}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {label}
          {badge != null && badge > 0 && ` (${badge})`}
          {liveCount != null && liveCount > 0 && ` - ${liveCount} live`}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <NavLink
      to={noPrefix ? fullPath : to}
      end={end}
      onClick={() => { if (isMobile) setSidebarOpen(false); }}
      className={({ isActive }) =>
        cn(
          "relative flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-medium transition-colors",
          isActive
            ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
            : "text-foreground/[0.78] hover:bg-white/[0.04] hover:text-foreground",
          className,
        )
      }
    >
      {({ isActive }: { isActive: boolean }) => (
        <>
          <span className="relative shrink-0">
            <Icon className="size-4 transition-colors duration-150" />
            {alert && (
              <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-red-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
            )}
          </span>
          <span className="flex-1 truncate">{label}</span>
          {liveCount != null && liveCount > 0 && (
            <span className="ml-auto flex items-center gap-1.5">
              <span className="relative flex size-2">
                <span className="animate-ping absolute inline-flex size-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full size-2 bg-blue-500" />
              </span>
              <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">{liveCount} live</span>
            </span>
          )}
          {badge != null && badge > 0 && (
            <span
              className={cn(
                "ml-auto rounded-full px-1.5 py-0.5 text-xs leading-none",
                badgeTone === "danger"
                  ? "bg-red-600/90 text-red-50"
                  : "bg-primary text-primary-foreground",
              )}
            >
              {badge}
            </span>
          )}
          {isActive && (
            <span
              aria-hidden
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
            />
          )}
        </>
      )}
    </NavLink>
  );
}
