import { ChevronUp, Maximize2, Minimize2, Minus } from "lucide-react";
import { AgentPanelContent } from "../InternalAgentPanel";
import { compactChat, type Presentation } from "./commander-presentation";
import "./UniverseCommanderChat.css";
import type { UniverseContext } from "@armyofagents/shared";

interface UniverseCommanderChatProps {
  conversationId: string | null;
  onSelectConversation: (id: string) => void;
  presentation: Presentation;
  onPresentationChange: (next: Presentation) => void;
  onTuck?: () => void;
  getUniverseContext?: () => UniverseContext | null;
}

/** Presentation-only adapter: the canonical panel owns history, drafts and sends. */
export function UniverseCommanderChat({ conversationId, onSelectConversation, presentation, onPresentationChange, onTuck, getUniverseContext }: UniverseCommanderChatProps) {
  const { chat } = presentation;
  const showHeader = chat === "expanded" || chat === "maximized";
  const expand = () => onPresentationChange({ ...presentation, chat: "expanded", lastVisible: "expanded", chatFrontmost: true });
  return (
    <section className="universe-commander-chat" data-chat-view={chat} aria-label="Commander chat" aria-hidden={chat === "tucked"}>
      {showHeader && (
        <header className="universe-commander-header">
          <span>Commander</span>
          <div>
            <button type="button" aria-label="Tuck Commander" title="Tuck" onClick={() => {
              onPresentationChange({ ...presentation, chat: "tucked", lastVisible: chat, chatFrontmost: false });
              onTuck?.();
            }}><Minus size={16} /></button>
            <button type="button" aria-label={chat === "maximized" ? "Restore Commander" : "Maximize Commander"} title={chat === "maximized" ? "Restore" : "Maximize"} onClick={() => chat === "maximized" ? expand() : onPresentationChange({ ...presentation, chat: "maximized", lastVisible: "maximized", chatFrontmost: true })}>{chat === "maximized" ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
            <button type="button" aria-label="Compact Commander" title="Compact" onClick={() => onPresentationChange(compactChat(presentation))}><ChevronUp size={16} className="rotate-180" /></button>
          </div>
        </header>
      )}
      {chat === "compact" && <button className="universe-commander-expand" type="button" aria-label="Expand Commander" title="Expand Commander" onClick={expand}><ChevronUp size={16} /></button>}
      <div className="universe-commander-content">
        <AgentPanelContent conversationId={conversationId} onSelectConversation={onSelectConversation} universeView={chat} getUniverseContext={getUniverseContext} />
      </div>
    </section>
  );
}
