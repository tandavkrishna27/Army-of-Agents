import {
  Inbox,
  CircleDot,
  Home,
  Users,
  Settings,
  Brain,
  Compass,
  Bot,
  MessageSquare,
  Boxes,
  Repeat,
  Shield,
  Puzzle,
  FolderGit2,
  LayoutList,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjectsByType } from "./SidebarProjectsByType";
import { SidebarCollapseToggle } from "./SidebarCollapseToggle";
import { BudgetSidebarMarker } from "./finance/BudgetSidebarMarker";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { pluginsApi } from "../api/plugins";
import { queryKeys } from "../lib/queryKeys";
import { useLiveAgentCount } from "../hooks/useLiveAgentCount";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { collapsed, toggleCollapse, isMobile } = useSidebar();
  const navigate = useNavigate();
  const { data: sidebarBadges } = useQuery({
    queryKey: queryKeys.sidebarBadges(selectedCompanyId!),
    queryFn: () => sidebarBadgesApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const liveRunCount = useLiveAgentCount();
  const { data: pluginContributions } = useQuery({
    queryKey: queryKeys.plugins.uiContributions(selectedCompanyId ?? ""),
    queryFn: () => pluginsApi.listUiContributions(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });
  const pluginsWithPages = (pluginContributions ?? []).filter(
    (c) => c.slots.some((s) => s.type === "page"),
  );

  const sidebarWidth = collapsed ? 56 : 220;

  return (
    <>
      <aside
        data-collapsed={collapsed}
        className={cn(
          "h-full min-h-0 flex flex-col border-r border-border bg-background transition-[width] duration-[180ms]",
          collapsed ? "w-[56px]" : "w-[220px]",
        )}
      >
        {/* Header — h-11, logo + company-name (click → lobby). No internal collapse toggle. */}
        <div
          className={cn(
            "flex items-center shrink-0 h-11 border-b border-border",
            collapsed ? "justify-center px-0" : "gap-2 px-3",
          )}
        >
          {collapsed ? (
            <a
              href="/"
              onClick={(e) => { e.preventDefault(); navigate("/"); }}
              title="Back to all companies"
              className="flex items-center justify-center size-8 rounded-md hover:bg-accent/50 transition-colors"
            >
              {selectedCompany?.logoAssetId ? (
                <img
                  src={`/api/assets/${selectedCompany.logoAssetId}/content`}
                  alt={selectedCompany.name}
                  className="size-6 rounded object-cover"
                />
              ) : selectedCompany?.brandColor ? (
                <div className="size-5 rounded shrink-0" style={{ backgroundColor: selectedCompany.brandColor }} />
              ) : (
                <div className="size-5 rounded bg-muted shrink-0" />
              )}
            </a>
          ) : (
            <>
              {selectedCompany?.logoAssetId ? (
                <img
                  src={`/api/assets/${selectedCompany.logoAssetId}/content`}
                  alt={selectedCompany.name}
                  className="size-5 rounded object-cover shrink-0"
                />
              ) : selectedCompany?.brandColor ? (
                <div className="size-5 rounded shrink-0" style={{ backgroundColor: selectedCompany.brandColor }} />
              ) : null}
              <a
                href="/"
                onClick={(e) => { e.preventDefault(); navigate("/"); }}
                className="flex-1 text-sm font-semibold text-foreground truncate hover:text-foreground/80 transition-colors"
                title="Back to all companies"
              >
                {selectedCompany?.name ?? "Select company"}
              </a>
            </>
          )}
        </div>

        {/* Nav — hidden scrollbar */}
        <nav
          className={cn(
            "flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 py-2",
            "[&::-webkit-scrollbar]:hidden [scrollbar-width:none]",
            collapsed ? "px-0 items-center" : "px-3",
          )}
        >
          {/* Top nav: Home + Inbox + Commander */}
          <div className={cn("flex flex-col gap-0.5", collapsed && "w-full items-center")}>
            <SidebarNavItem to="/home" label="Home" icon={Home} liveCount={liveRunCount} collapsed={collapsed} />
            <SidebarNavItem
              to="/inbox"
              label="Inbox"
              icon={Inbox}
              badge={sidebarBadges?.inbox}
              badgeTone={sidebarBadges?.failedRuns ? "danger" : "default"}
              alert={(sidebarBadges?.failedRuns ?? 0) > 0}
              collapsed={collapsed}
            />
            <SidebarNavItem to="/commander" label="Commander" icon={Shield} collapsed={collapsed} />
          </div>

          {/* WORK section — entityColor props removed (Decision A) */}
          <SidebarSection label="Work" collapsed={collapsed}>
            <SidebarNavItem to="/discussions" label="Discussions" icon={MessageSquare} badge={sidebarBadges?.pendingDiscussions} collapsed={collapsed} />
            <SidebarNavItem to="/issues" label="Tasks" icon={CircleDot} collapsed={collapsed} />
            <SidebarNavItem to="/team?tab=aoa&aoaTab=tasks" label="Crew Board" icon={LayoutList} collapsed={collapsed} />
            <SidebarNavItem to="/agents/all" label="Agents" icon={Bot} collapsed={collapsed} />
            <SidebarNavItem to="/routines" label="Routines" icon={Repeat} collapsed={collapsed} />
            <SidebarNavItem to="/workspaces" label="Workspaces" icon={FolderGit2} collapsed={collapsed} />
          </SidebarSection>

          {/* DEPARTMENTS — colored square (Pattern A, unchanged) */}
          <SidebarProjectsByType type="department" label="Departments" collapsed={collapsed} />

          {/* PROJECTS — Rocket tinted in entity color (Task 3) */}
          <SidebarProjectsByType type="project" label="Projects" collapsed={collapsed} />

          {/* COMPANY section — entityColor on Memory removed (Decision A) */}
          <SidebarSection label="Company" collapsed={collapsed}>
            <SidebarNavItem to="/objectives" label="Objectives" icon={Compass} collapsed={collapsed} />
            <SidebarNavItem to="/memory" label="Memory" icon={Brain} collapsed={collapsed} />
            <SidebarNavItem to="/team" label="Team" icon={Users} collapsed={collapsed} />
            <SidebarNavItem to="/skills" label="Skills" icon={Boxes} collapsed={collapsed} />
            <SidebarNavItem to="/settings" label="Settings" icon={Settings} collapsed={collapsed} />
            <BudgetSidebarMarker collapsed={collapsed} />
          </SidebarSection>

          {/* PLUGINS — conditional, unchanged */}
          {pluginsWithPages.length > 0 && (
            <SidebarSection label="Plugins" collapsed={collapsed}>
              {pluginsWithPages.map((contribution) => (
                <SidebarNavItem
                  key={contribution.pluginId}
                  to={`/plugins/${contribution.pluginId}`}
                  label={contribution.displayName}
                  icon={Puzzle}
                  collapsed={collapsed}
                />
              ))}
            </SidebarSection>
          )}
        </nav>

        {/* No bottom UserMenu (Phase E — moved to lobby only) */}
      </aside>

      {/* External collapse toggle — hidden in mobile drawer mode (parity with LobbySidebar) */}
      {!isMobile && (
        <SidebarCollapseToggle
          collapsed={collapsed}
          onToggle={toggleCollapse}
          sidebarWidth={sidebarWidth}
          className="hidden md:inline-flex"
        />
      )}
    </>
  );
}
