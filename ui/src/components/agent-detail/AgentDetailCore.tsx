import type { Agent } from "@armyofagents/shared";
import type { PageTabItem } from "../PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "../PageTabBar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AgentHeroCard, type HeroKpi } from "./AgentHeroCard";

export interface AgentDetailCoreActionBar {
  show: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}

export interface AgentDetailCoreProps {
  agent: Agent;
  tabs: PageTabItem[];
  activeView: string;
  onViewChange: (v: string) => void;
  /** Worker-specific action buttons (invoke/pause/resume/more-menu) or AoA-specific actions */
  headerActions?: React.ReactNode;
  /** Floating save/cancel bar (for config/instructions dirty state) */
  actionBar?: AgentDetailCoreActionBar;
  urlRunId?: string | null;
  isMobile?: boolean;
  /** Callback when user picks a new icon */
  onIconChange?: (icon: string) => void;
  /** Hero KPI strip (page-computed values + deep-links) */
  heroKpis?: HeroKpi[];
  /** Hero adapter/model badges */
  heroBadges?: { adapter?: string; model?: string };
  /** Header-error line rendered under the hero card */
  headerError?: string | null;
  /** Render the content for the active tab */
  renderTab: (view: string) => React.ReactNode;
}

/**
 * AgentDetailCore – shared chrome for agent detail pages.
 *
 * Renders:
 *   - Hero card (AgentHeroCard: icon, name, status, badges, KPI strip, actions, error)
 *   - Floating save/cancel bar (desktop + mobile)
 *   - Tab bar (PageTabBar inside Tabs)
 *   - Tab content via renderTab()
 *
 * All data fetching stays in the parent page (AgentDetail or AoaAgentDetail).
 */
export function AgentDetailCore({
  agent,
  tabs,
  activeView,
  onViewChange,
  headerActions,
  actionBar,
  urlRunId,
  isMobile = false,
  onIconChange,
  heroKpis,
  heroBadges,
  headerError,
  renderTab,
}: AgentDetailCoreProps) {
  const showActionBar = actionBar?.show ?? false;

  return (
    <div className={cn("space-y-6", isMobile && showActionBar && "pb-24")}>
      {/* Hero card */}
      <AgentHeroCard
        agent={agent}
        kpis={heroKpis}
        badges={heroBadges}
        actions={headerActions}
        onIconChange={onIconChange}
        error={headerError}
      />

      {/* Floating Save/Cancel (desktop) */}
      {!isMobile && actionBar && (
        <div
          data-testid="agent-detail-action-bar"
          // `data-dirty` mirrors showActionBar so tests can deterministically wait
          // for the unsaved-changes state to arm (the bar stays mounted and only
          // fades via opacity, which Playwright's visibility checks ignore).
          data-dirty={showActionBar ? "true" : "false"}
          className={cn(
            "sticky top-6 z-10 float-right transition-opacity duration-150",
            showActionBar
              ? "opacity-100"
              : "opacity-0 pointer-events-none"
          )}
        >
          <div className="flex items-center gap-2 bg-background/90 backdrop-blur-sm border border-border rounded-lg px-3 py-1.5 shadow-lg">
            <Button
              variant="ghost"
              size="sm"
              onClick={actionBar.onCancel}
              disabled={actionBar.saving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={actionBar.onSave}
              disabled={actionBar.saving}
            >
              {actionBar.saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* Mobile bottom Save/Cancel bar */}
      {isMobile && showActionBar && actionBar && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur-sm">
          <div
            className="flex items-center justify-end gap-2 px-3 py-2"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={actionBar.onCancel}
              disabled={actionBar.saving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={actionBar.onSave}
              disabled={actionBar.saving}
            >
              {actionBar.saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* Tab navigation — always shown; a selected run is still within the
          Runs tab (master-detail), so the tab bar must not vanish. */}
      <Tabs
        value={activeView}
        onValueChange={onViewChange}
        activationMode="manual"
      >
        <PageTabBar
          items={tabs}
          value={activeView}
          onValueChange={onViewChange}
        />
      </Tabs>

      {/* Tab content */}
      {renderTab(activeView)}
    </div>
  );
}
