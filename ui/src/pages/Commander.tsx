import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { AgentPanelContent } from "../components/InternalAgentPanel";
import { SessionsSidebar } from "../components/commander";
import { COMMANDER_PANEL_ROW } from "../components/commander/commanderChrome";
import { useCommanderSessionsCollapsed } from "../components/commander/useCommanderSessionsCollapsed";
import { commanderConversationsApi, internalAgentApi } from "../api/internal-agent";
import { queryKeys } from "../lib/queryKeys";
import { useBreakpoint } from "../lib/useBreakpoint";
import { cn } from "../lib/utils";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

export function Commander() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  // Task 11: on mobile/tablet (< 1024px) the sessions list lives in a left
  // drawer instead of an inline sidebar.
  const { useDrawerSessions } = useBreakpoint();
  const [sessionsDrawerOpen, setSessionsDrawerOpen] = useState(false);

  // Phase 6 [A1]: Lift sessions collapse state so the choreography in
  // AgentPanelContent can collapse sessions (which lives here as a sibling).
  // Keep the global localStorage key via the existing hook — both the sidebar
  // and the panel read/write the same key.
  const [sessionsCollapsed, setSessionsCollapsed] = useCommanderSessionsCollapsed();

  useEffect(() => {
    setBreadcrumbs([{ label: "Commander" }]);
  }, [setBreadcrumbs]);

  const { data: config } = useQuery({
    queryKey: queryKeys.agentConfig(selectedCompanyId!),
    queryFn: () => internalAgentApi.getConfig(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const handleNewConversation = async () => {
    if (!selectedCompanyId) return;
    const conv = await commanderConversationsApi.create(selectedCompanyId);
    setActiveConversationId(conv.id);
    // Close the drawer after starting a new chat on mobile/tablet.
    setSessionsDrawerOpen(false);
    queryClient.invalidateQueries({ queryKey: ["commander-conversations"] });
  };

  // Selecting a session closes the drawer (no-op on desktop where it's never open).
  const handleSelectConversation = (id: string) => {
    setActiveConversationId(id);
    setSessionsDrawerOpen(false);
  };

  return (
    // Commander is a full-bleed route — Layout drops the global <main> padding
    // for `/commander`, so we just fill main with h-full (no negative-margin
    // hack, no 100vh math). main keeps its mobile bottom padding, which lifts the
    // input clear of the MobileBottomNav and keeps main from scrolling (h-full
    // resolves to main's content box, so content + pb == client → no outer
    // scrollbar; only the message list scrolls).
    <div className="flex flex-col h-full min-h-0">

      {/* Best-effort badge (non-claude_cli warning) */}
      {config?.cliTool && config.cliTool !== "claude_cli" && (
        <div className="px-5 py-1.5 bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-200 inline-flex items-center gap-1.5 shrink-0">
          <Info className="h-3 w-3 shrink-0" />
          <span>Confirmation gates use best-effort detection on <code className="font-mono">{config.cliTool}</code>. Switch to Claude CLI for strict gating.</span>
        </div>
      )}

      {/* Chat workspace — sessions + chat panel, fills remaining height */}
      <div className={cn("flex flex-1 min-h-0 overflow-hidden", COMMANDER_PANEL_ROW)}>
        {/* Desktop/wide (>= 1024px): inline sessions sidebar — UNCHANGED */}
        {!useDrawerSessions && (
          <SessionsSidebar
            chrome
            activeConversationId={activeConversationId}
            onSelect={setActiveConversationId}
            onNewConversation={handleNewConversation}
            collapsed={sessionsCollapsed}
            onSetCollapsed={setSessionsCollapsed}
          />
        )}

        <div className="flex-1 min-w-0 overflow-hidden">
          <AgentPanelContent
            conversationId={activeConversationId}
            onSelectConversation={handleSelectConversation}
            onOpenSessions={useDrawerSessions ? () => setSessionsDrawerOpen(true) : undefined}
            enableViewerPanel
            cardChrome
            sessionsCollapsed={sessionsCollapsed}
            onSetSessionsCollapsed={setSessionsCollapsed}
          />
        </div>

        {/* Mobile/tablet (< 1024px): sessions in a left slide-in drawer.
            Radix Dialog (Sheet) provides focus trap + Escape automatically. */}
        {useDrawerSessions && (
          <Sheet open={sessionsDrawerOpen} onOpenChange={setSessionsDrawerOpen}>
            <SheetContent side="left" showCloseButton className="w-auto sm:max-w-[15rem] p-0">
              <SheetTitle className="sr-only">Sessions</SheetTitle>
              <SessionsSidebar
                activeConversationId={activeConversationId}
                onSelect={handleSelectConversation}
                onNewConversation={handleNewConversation}
              />
            </SheetContent>
          </Sheet>
        )}
      </div>
    </div>
  );
}
