import type { ReactNode } from "react";
import { Maximize2, Minimize2, PanelBottom } from "lucide-react";
import { CommanderBlob, type VoiceState } from "./CommanderBlob";
import { CommanderCaptions } from "./CommanderCaptions";
import type { Presentation } from "./commander-presentation";
import "./commander-surface.css";

export interface CommanderMessage {
  id: string;
  role: "user" | "commander";
  text: string;
}

export interface CommanderSurfaceProps {
  presentation: Presentation;
  statusText?: string;
  captionText?: string;
  messages?: CommanderMessage[];
  voiceState?: VoiceState;
  /** Live app passes the real CommanderInput here; the harness uses the shell. */
  composer?: ReactNode;
  /** Blob / tray primary click → toggleTrayChat (owned by the composition). */
  onPrimary: () => void;
  onExpand?: () => void;
  onCompact?: () => void;
  onMaximize?: () => void;
  onRestore?: () => void;
  onTuck?: () => void;
  onHideBlob?: () => void;
  onStartVoice?: () => void;
}

/** Fallback compact chat bar for the harness/demo. In the live app the `composer`
 * slot supplies the real CommanderInput, so this shell is never rendered. */
function CompactShell({ onExpand }: { onExpand?: () => void }) {
  return (
    <div className="universe-commander-compact">
      <button type="button" className="uc-add" aria-label="Add">
        +
      </button>
      <input aria-label="Ask Commander" placeholder="Ask Commander…" />
      <button
        type="button"
        className="uc-expand"
        aria-label="Expand chat"
        onClick={onExpand}
      >
        <Maximize2 size={14} aria-hidden />
      </button>
      <span className="uc-voice" aria-hidden />
      <button type="button" className="uc-send" aria-label="Send">
        ↑
      </button>
    </div>
  );
}

export function CommanderSurface({
  presentation,
  statusText = "Commander: I'm here. Ready when you are.",
  captionText,
  messages = [],
  voiceState = "unavailable",
  composer,
  onPrimary,
  onExpand,
  onCompact,
  onMaximize,
  onRestore,
  onTuck,
  onHideBlob,
  onStartVoice,
}: CommanderSurfaceProps) {
  const { chat, blob } = presentation;
  const expandedLike = chat === "expanded" || chat === "maximized";

  return (
    <div className="universe-commander" data-chat={chat}>
      {blob && (
        <div className="universe-commander-center">
          <CommanderBlob
            voiceState={voiceState}
            onPrimary={onPrimary}
            onStartVoice={onStartVoice}
            onHide={onHideBlob}
          />
        </div>
      )}

      <div className="universe-commander-dock">
        {chat !== "expanded" && chat !== "maximized" && (
          <p className="universe-commander-status">{statusText}</p>
        )}

        {chat !== "tucked" && (
          <CommanderCaptions
            text={captionText}
            placement="above-compact"
          />
        )}
        {chat === "tucked" && (
          <CommanderCaptions text={captionText} placement="bottom-center" />
        )}

        {chat === "compact" && (
          <div className="universe-commander-composer">
            {composer ?? <CompactShell onExpand={onExpand} />}
          </div>
        )}

        {expandedLike && (
          <div className="universe-commander-panel">
            <header className="universe-commander-panel-head">
              <span>Commander</span>
              <div className="uc-controls">
                <button type="button" aria-label="Tuck chat" onClick={onTuck}>
                  <PanelBottom size={15} aria-hidden />
                </button>
                {chat === "maximized" ? (
                  <button
                    type="button"
                    aria-label="Restore chat"
                    onClick={onRestore}
                  >
                    <Minimize2 size={15} aria-hidden />
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label="Maximize chat"
                    onClick={onMaximize}
                  >
                    <Maximize2 size={15} aria-hidden />
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Compact chat"
                  onClick={onCompact}
                >
                  <PanelBottom size={15} aria-hidden style={{ opacity: 0.7 }} />
                </button>
              </div>
            </header>
            <div className="universe-commander-history">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className="universe-commander-msg"
                  data-role={m.role}
                >
                  {m.text}
                </div>
              ))}
            </div>
            <div className="universe-commander-panel-composer">
              {composer ?? <CompactShell />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
