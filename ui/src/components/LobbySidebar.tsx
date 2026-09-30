import { useLayoutEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { profileApi } from "@/api/profile";
import { queryKeys } from "@/lib/queryKeys";
import {
  BookOpen,
  Building2,
  ChevronDown,
  FileText,
  Plus,
  Settings,
  Store,
  Upload,
} from "lucide-react";
import { UserMenu } from "@/components/UserMenu";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SidebarCollapseToggle } from "@/components/SidebarCollapseToggle";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "aoa.lobby.sidebar-collapsed";

// The rail floats with an `ml-2` (8px) left gutter and `my-2` top gutter. The
// external collapse toggle must shift right by the gutter to stay on the
// rail/main seam, and down to align with the header row inside the floated card.
// Keep these in lockstep with the aside's `my-2 ml-2` classes.
const RAIL_GUTTER_PX = 8;
const RAIL_TOGGLE_TOP_PX = 17;

interface LobbyNavRowProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  collapsed?: boolean;
  onClick: () => void;
}

function LobbyNavRow({ icon: Icon, label, active, collapsed, onClick }: LobbyNavRowProps) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      data-active={active ? "true" : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "relative flex w-full items-center gap-2.5 rounded-md text-[13px] font-medium transition-colors",
        collapsed ? "h-9 justify-center px-0" : "px-3 py-2",
        active
          ? "bg-brand/[0.08] text-sidebar-active-text"
          : "text-foreground/[0.78] hover:bg-white/[0.04] hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="flex-1 truncate text-left">{label}</span>}
      {active && (
        <span
          aria-hidden
          className={cn(
            "absolute size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]",
            collapsed ? "right-1.5 top-1.5" : "right-2.5 top-1/2 -translate-y-1/2",
          )}
        />
      )}
    </button>
  );

  if (!collapsed) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Keys for the lobby-level nav items (the rows visible in {@link LobbySidebar}). */
export type LobbySidebarItem =
  | "organizations"
  | "marketplace"
  | "learn"
  | "documentation"
  | "settings";

interface LobbySidebarProps {
  onCreateCompany: () => void;
  /**
   * Which nav row to highlight as active. Defaults to "organizations" so the
   * Lobby page (the original consumer) keeps working without changes.
   */
  activeItem?: LobbySidebarItem;
  /**
   * When true, the sidebar runs in "drawer" mode — always expanded, no
   * external collapse toggle, no localStorage persistence. Used inside a
   * mobile Sheet drawer where collapsing doesn't make sense.
   */
  drawer?: boolean;
  /** Optional callback invoked when a nav item is clicked (for closing the drawer on mobile). */
  onNavigate?: () => void;
  /**
   * Reactive: when true (the current page provides a secondary sidebar), the
   * primary force-collapses out of the way; the user may still peek-expand it
   * transiently (not persisted). When false, the primary reflects the persisted
   * preference and manual toggles update it. See design-system §8.1.1.
   */
  hasSecondarySidebar?: boolean;
}

/**
 * Sidebar for the global Lobby page.
 *
 * Pre-company-selection chrome. Header: AoA. wordmark. Below: prominent
 * "+ New company" CTA. Nav grouped Companies / Marketplace, then Learn
 * (Learn + Documentation), then System (Settings). Footer: UserMenu
 * (squircle avatar). External {@link SidebarCollapseToggle} floats on the
 * right edge of the sidebar (top-aligned with the AoA. wordmark).
 *
 * Collapsed state shrinks to 56px wide, hiding labels (tooltips show on hover)
 * and section headers. Persisted via localStorage `aoa.lobby.sidebar-collapsed`.
 *
 * When `drawer` is true (mobile menu mode), the sidebar is always rendered at
 * full width (no collapse), the external collapse toggle is hidden, and the
 * `onNavigate` callback fires after each nav click so the parent can close
 * the drawer.
 */
export function LobbySidebar({
  onCreateCompany,
  activeItem = "organizations",
  drawer = false,
  onNavigate,
  hasSecondarySidebar = false,
}: LobbySidebarProps) {
  const navigate = useNavigate();
  // Persisted global preference (only mutated by manual toggles on pages WITHOUT
  // a secondary sidebar). `collapsed` is what's actually rendered.
  const [pref, setPref] = useState<boolean>(() => {
    if (drawer) return false;
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    drawer ? false : hasSecondarySidebar ? true : pref,
  );

  // React to navigating into/out of a secondary-sidebar page: force-collapse
  // when a secondary sidebar is present, otherwise reflect the preference.
  // useLayoutEffect (not useEffect) so the collapse lands BEFORE paint — the
  // persistent LobbyLayout never remounts this sidebar, so a post-paint effect
  // would flash the expanded rail beside the secondary sidebar for one frame.
  useLayoutEffect(() => {
    if (drawer) return;
    setCollapsed(hasSecondarySidebar ? true : pref);
  }, [drawer, hasSecondarySidebar, pref]);

  const handleToggle = () => {
    if (hasSecondarySidebar) {
      // Transient peek on a secondary-sidebar page — do not persist.
      setCollapsed((c) => !c);
      return;
    }
    const next = !collapsed;
    setCollapsed(next);
    setPref(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, String(next));
    } catch {
      // noop — storage may be disabled
    }
  };

  // Instance-Settings row gate: /instance/settings is instance-admin-only (the
  // server 403s everyone else), so hide the row for non-admins. While the
  // profile is loading the row stays hidden — no flash of a row that would
  // dead-end in a 403. Deep links still resolve: InstanceSettingsPage renders
  // a friendly access notice for non-admins.
  const { data: profile } = useQuery({
    queryKey: queryKeys.auth.profile,
    queryFn: () => profileApi.get(),
    staleTime: 60_000,
  });
  const showInstanceSettings = profile?.canManageInstanceSettings === true;

  const navTo = (path: string) => {
    navigate(path);
    onNavigate?.();
  };

  const create = () => {
    onCreateCompany();
    onNavigate?.();
  };

  return (
    <>
      <aside
        data-collapsed={collapsed}
        data-drawer={drawer || undefined}
        className={cn(
          "relative flex shrink-0 flex-col",
          drawer
            ? "w-full h-dvh"
            : "h-[calc(100dvh-1rem)] my-2 ml-2 overflow-hidden rounded-2xl border border-border bg-card/50 backdrop-blur-sm transition-[width] duration-[180ms]",
          !drawer && (collapsed ? "w-[56px]" : "w-[220px]"),
          !drawer && "lobby-sidebar-enter",
        )}
      >
        {/* Header — AoA. wordmark */}
        <div
          className={cn(
            "flex h-14 shrink-0 items-center border-b border-border",
            collapsed ? "justify-center px-0" : "px-4",
          )}
        >
          <span className="text-base font-extrabold tracking-[-0.02em] text-foreground">
            {collapsed ? "A" : "AoA"}
            <span className="text-brand">.</span>
          </span>
        </div>

        {/* + New company button */}
        <div
          className={cn(
            "shrink-0 border-b border-border-soft",
            collapsed ? "px-2 py-2.5" : "px-3 py-3.5",
          )}
        >
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  onClick={create}
                  aria-label="New company"
                  className="size-9 mx-auto"
                >
                  <Plus />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                New company
              </TooltipContent>
            </Tooltip>
          ) : (
            <DropdownMenu>
              {/* Attached split button — primary creates in one click; the
                  joined chevron segment opens a floating menu (no layout shift). */}
              <div className="flex">
                <Button
                  size="default"
                  onClick={create}
                  className="flex-1 justify-center gap-1.5 rounded-r-none"
                >
                  <Plus />
                  New company
                </Button>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="default"
                    aria-label="More company options"
                    className="rounded-l-none border-l border-l-black/20 px-2 data-[state=open]:[&_svg]:rotate-180"
                  >
                    <ChevronDown className="size-4 transition-transform" />
                  </Button>
                </DropdownMenuTrigger>
              </div>
              <DropdownMenuContent align="end" sideOffset={6} className="min-w-[200px]">
                <DropdownMenuItem onSelect={() => navTo("/import")}>
                  <Upload />
                  Import company
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Nav rows */}
        <nav className="flex flex-1 flex-col gap-0.5 p-2">
          <LobbyNavRow
            icon={Building2}
            label="Companies"
            active={activeItem === "organizations"}
            collapsed={collapsed}
            onClick={() => navTo("/")}
          />
          <LobbyNavRow
            icon={Store}
            label="Marketplace"
            active={activeItem === "marketplace"}
            collapsed={collapsed}
            onClick={() => navTo("/marketplace")}
          />

          {!collapsed && (
            <div className="mt-2 px-2.5 py-1 text-[0.6rem] font-semibold uppercase tracking-[0.1em] opacity-50">
              Learn
            </div>
          )}
          {collapsed && <div className="my-2 mx-1 h-px bg-border-soft" aria-hidden />}
          <LobbyNavRow
            icon={BookOpen}
            label="Learn"
            active={activeItem === "learn"}
            collapsed={collapsed}
            onClick={() => navTo("/learn")}
          />
          <LobbyNavRow
            icon={FileText}
            label="Documentation"
            active={activeItem === "documentation"}
            collapsed={collapsed}
            onClick={() => navTo("/docs")}
          />

          {showInstanceSettings && (
            <>
              {!collapsed && (
                <div className="mt-2 px-2.5 py-1 text-[0.6rem] font-semibold uppercase tracking-[0.1em] opacity-50">
                  System
                </div>
              )}
              {collapsed && <div className="my-2 mx-1 h-px bg-border-soft" aria-hidden />}
              <LobbyNavRow
                icon={Settings}
                label="Settings"
                active={activeItem === "settings"}
                collapsed={collapsed}
                onClick={() => navTo("/instance/settings")}
              />
            </>
          )}
        </nav>

        {/* User menu */}
        <div className="shrink-0 border-t border-border p-2">
          <UserMenu collapsed={collapsed} />
        </div>
      </aside>

      {/* External collapse button — floats on the sidebar/main border,
          top-aligned with AoA. Only on tablet+ (md+). Hidden on mobile (where
          the sidebar lives in a Sheet drawer instead). Hidden in drawer mode. */}
      {!drawer && (
        <SidebarCollapseToggle
          collapsed={collapsed}
          onToggle={handleToggle}
          sidebarWidth={(collapsed ? 56 : 220) + RAIL_GUTTER_PX}
          top={RAIL_TOGGLE_TOP_PX}
          className="hidden md:inline-flex"
        />
      )}
    </>
  );
}
