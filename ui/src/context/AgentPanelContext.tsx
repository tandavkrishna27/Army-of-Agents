import { createContext, useCallback, useContext, useMemo, useState, useEffect, type ReactNode } from "react";
import { useSidebar } from "./SidebarContext";

const PANEL_KEY = "aoa:agent-panel-open";

interface AgentPanelContextValue {
  isOpen: boolean;
  isStreaming: boolean;
  currentConversationId: string | null;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  setIsStreaming: (v: boolean) => void;
  setCurrentConversationId: (id: string | null) => void;
}

const AgentPanelContext = createContext<AgentPanelContextValue | null>(null);

export function AgentPanelProvider({ children }: { children: ReactNode }) {
  const { isMobile } = useSidebar();

  const [isOpen, setIsOpen] = useState(() => {
    if (typeof window === "undefined" || window.innerWidth < 768) return false;
    try {
      return localStorage.getItem(PANEL_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);

  // DA-23: On mobile, panel is never persisted open
  useEffect(() => {
    if (isMobile) setIsOpen(false);
  }, [isMobile]);

  const persist = useCallback((open: boolean) => {
    try {
      localStorage.setItem(PANEL_KEY, String(open));
    } catch { /* ignore */ }
  }, []);

  const openPanel = useCallback(() => {
    setIsOpen(true);
    if (!isMobile) persist(true);
  }, [isMobile, persist]);

  const closePanel = useCallback(() => {
    setIsOpen(false);
    if (!isMobile) persist(false);
  }, [isMobile, persist]);

  const togglePanel = useCallback(() => {
    setIsOpen((v) => {
      const next = !v;
      if (!isMobile) persist(next);
      return next;
    });
  }, [isMobile, persist]);

  const value = useMemo(
    () => ({
      isOpen,
      isStreaming,
      currentConversationId,
      openPanel,
      closePanel,
      togglePanel,
      setIsStreaming,
      setCurrentConversationId,
    }),
    [isOpen, isStreaming, currentConversationId, openPanel, closePanel, togglePanel],
  );

  return (
    <AgentPanelContext.Provider value={value}>
      {children}
    </AgentPanelContext.Provider>
  );
}

export function useAgentPanel() {
  const ctx = useContext(AgentPanelContext);
  if (!ctx) {
    throw new Error("useAgentPanel must be used within AgentPanelProvider");
  }
  return ctx;
}
