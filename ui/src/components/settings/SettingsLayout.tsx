import { useEffect, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useSidebar } from "@/context/SidebarContext";
import { Building, Shield, KeyRound, DollarSign, Plug, Cable, Puzzle, Store, Archive, Github, Activity, Layers, HeartPulse, PanelLeft, PanelLeftClose, Brain, Terminal, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const SECONDARY_COLLAPSED_KEY = "aoa.settings-secondary-collapsed";

export type SettingsSectionId =
  | "general" | "health" | "commander" | "memory" | "providers" | "budget" | "mcp" | "connectors" | "github"
  | "plugins" | "marketplace" | "archive"
  | "activity" | "environments" | "secrets" | "inbox";

/**
 * Accepted ?tab= input alias. The old "llm" tab value is still accepted on
 * read (so bookmarks survive) but normalizes to the canonical "memory".
 */
export type SettingsSectionAlias = SettingsSectionId | "llm";

interface SettingsItem {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
  tone?: "danger";
}

interface SettingsGroup {
  group: string;
  items: readonly SettingsItem[];
}

export const SETTINGS_SECTIONS: readonly SettingsGroup[] = [
  { group: "Company",    items: [
    { id: "general",     label: "General",            icon: Building },
    { id: "activity",    label: "Activity",           icon: Activity },
  ]},
  { group: "Operations", items: [
    { id: "inbox",        label: "Inbox",              icon: Inbox },
    { id: "health",       label: "Health",             icon: HeartPulse },
    { id: "commander",    label: "Commander",          icon: Shield },
    { id: "memory",       label: "Memory",             icon: Brain },
    { id: "providers",    label: "Providers",          icon: Terminal },
    { id: "budget",       label: "Budget & caps",      icon: DollarSign },
    { id: "mcp",          label: "MCP API keys",       icon: Plug },
    { id: "connectors",   label: "Connectors",         icon: Cable },
    { id: "environments", label: "Environments",       icon: Layers },
    { id: "secrets",      label: "Secrets",            icon: KeyRound },
    { id: "github",       label: "GitHub",             icon: Github },
  ]},
  { group: "Extensions", items: [
    { id: "plugins",     label: "Plugins",            icon: Puzzle },
    { id: "marketplace", label: "Marketplace prefs",  icon: Store },
  ]},
  { group: "Danger",     items: [
    { id: "archive",     label: "Archive company",    icon: Archive, tone: "danger" },
  ]},
];

interface SettingsLayoutProps {
  activeSection: SettingsSectionId;
  onSectionChange: (id: SettingsSectionId) => void;
  children: ReactNode;
}

export function SettingsLayout({ activeSection, onSectionChange, children }: SettingsLayoutProps) {
  const { setCollapsed: setPrimaryCollapsed, isMobile } = useSidebar();

  // Decision #98 — auto-collapse PRIMARY sidebar on entry to give SECONDARY the prominent role.
  useEffect(() => {
    if (!isMobile) setPrimaryCollapsed(true);
  }, [isMobile, setPrimaryCollapsed]);

  // Secondary sidebar collapse state, persisted to localStorage.
  const [secondaryCollapsed, setSecondaryCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SECONDARY_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const toggleSecondary = () => {
    setSecondaryCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(SECONDARY_COLLAPSED_KEY, String(next)); } catch { /* noop */ }
      return next;
    });
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-muted/30 p-2 md:flex-row md:gap-2">
      {/* SecondarySidebar — desktop only. NO redundant "Settings" header. */}
      <aside
        className={cn(
          "hidden md:flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-[width] duration-[180ms]",
          secondaryCollapsed ? "w-[48px]" : "w-[200px]",
        )}
      >
        <div
          className={cn(
            "flex h-[42px] shrink-0 items-center border-b border-border",
            secondaryCollapsed ? "justify-center px-0" : "gap-2 px-3",
          )}
          data-testid="settings-secondary-header"
        >
          {!secondaryCollapsed && (
            <div className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
              Settings
            </div>
          )}
          <button
            type="button"
            onClick={toggleSecondary}
            title={secondaryCollapsed ? "Expand settings nav" : "Collapse settings nav"}
            aria-label={secondaryCollapsed ? "Expand settings nav" : "Collapse settings nav"}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            {secondaryCollapsed
              ? <PanelLeft className="h-4 w-4" aria-hidden />
              : <PanelLeftClose className="h-4 w-4" aria-hidden />}
          </button>
        </div>
        <nav
          className={cn(
            "flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none] py-3",
            secondaryCollapsed ? "px-1" : "px-2",
          )}
        >
          {SETTINGS_SECTIONS.map((group, gi) => (
            <div key={group.group} className={cn(gi > 0 && (secondaryCollapsed ? "mt-2 pt-2 border-t border-border-soft mx-1" : "mt-3"))}>
              {!secondaryCollapsed && (
                <div className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60">
                  {group.group}
                </div>
              )}
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = activeSection === item.id;
                const isDanger = item.tone === "danger";
                const button = (
                  <button
                    type="button"
                    onClick={() => onSectionChange(item.id)}
                    className={cn(
                      "relative w-full flex items-center rounded-md transition-colors",
                      secondaryCollapsed
                        ? "h-9 justify-center"
                        : "h-[30px] gap-2.5 px-2.5 text-[13px] font-medium",
                      active
                        ? "bg-brand/[0.08] text-sidebar-active-text"
                        : "text-foreground/[0.78] hover:bg-white/[0.04] hover:text-foreground",
                    )}
                  >
                    <Icon className={cn("size-4 shrink-0", isDanger && "text-red-400/80")} />
                    {!secondaryCollapsed && (
                      <span className="flex-1 text-left truncate">{item.label}</span>
                    )}
                    {active && (
                      <span aria-hidden className={cn(
                        "pointer-events-none absolute size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]",
                        secondaryCollapsed ? "right-1.5 top-1.5" : "right-2.5 top-1/2 -translate-y-1/2",
                      )} />
                    )}
                  </button>
                );
                if (!secondaryCollapsed) return <div key={item.id}>{button}</div>;
                return (
                  <Tooltip key={item.id}>
                    <TooltipTrigger asChild>{button}</TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8}>
                      {item.label}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* Mobile sub-nav — horizontal scrollable pill row */}
      <div className="md:hidden border-b border-border-soft py-2 px-3 flex gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {SETTINGS_SECTIONS.flatMap((g) => g.items).map((item) => {
          const Icon = item.icon;
          const active = activeSection === item.id;
          const isDanger = item.tone === "danger";
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSectionChange(item.id)}
              className={cn(
                "shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium border whitespace-nowrap",
                active
                  ? "bg-brand/[0.12] border-brand/40 text-sidebar-active-text"
                  : "bg-card border-border text-muted-foreground",
                isDanger && !active && "text-red-400/80",
              )}
            >
              <Icon className="size-3.5" />
              {item.label}
            </button>
          );
        })}
      </div>

      {/* Main content panel */}
      <main className="flex-1 min-w-0 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {children}
      </main>
    </div>
  );
}
