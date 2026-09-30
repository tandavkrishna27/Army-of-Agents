import { useMemo } from "react";
import { NavLink } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import {
  House,
  CircleDot,
  Bot,
  Users,
  Inbox,
} from "lucide-react";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";


interface MobileBottomNavProps {
  visible: boolean;
}

interface MobileNavLinkItem {
  type: "link";
  to: string;
  label: string;
  icon: typeof House;
  badge?: number;
}

type MobileNavItem = MobileNavLinkItem;

export function MobileBottomNav({ visible }: MobileBottomNavProps) {
  const { selectedCompanyId } = useCompany();

  const { data: sidebarBadges } = useQuery({
    queryKey: queryKeys.sidebarBadges(selectedCompanyId!),
    queryFn: () => sidebarBadgesApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const items = useMemo<MobileNavItem[]>(
    () => [
      { type: "link", to: "/home", label: "Home", icon: House },
      { type: "link", to: "/issues", label: "Tasks", icon: CircleDot },
      { type: "link", to: "/commander", label: "Commander", icon: Bot },
      { type: "link", to: "/agents/all", label: "Agents", icon: Users },
      {
        type: "link",
        to: "/inbox",
        label: "Inbox",
        icon: Inbox,
        badge: sidebarBadges?.inbox,
      },
    ],
    [sidebarBadges?.inbox],
  );

  return (
    <nav
      className={cn(
        "fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 transition-transform duration-200 ease-out md:hidden pb-[env(safe-area-inset-bottom)]",
        visible ? "translate-y-0" : "translate-y-full",
      )}
      aria-label="Mobile navigation"
    >
      <div className="grid h-16 grid-cols-5 px-1">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.label}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-md text-[10px] font-medium transition-colors",
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    <Icon className={cn("h-[18px] w-[18px]", isActive && "stroke-[2.3]")} />
                    {item.badge != null && item.badge > 0 && (
                      <span className="absolute -right-2 -top-2 rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground">
                        {item.badge > 99 ? "99+" : item.badge}
                      </span>
                    )}
                  </span>
                  <span className="truncate">{item.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
