// ui/src/components/workspace/ChatbarControls.tsx
import { AtSign, Mic, Paperclip, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ComposerIconButton } from "../composer/ComposerIconButton";
import { shortModelName } from "./adapter-utils";

interface ChatbarControlsProps {
  adapterType: string;
  /** The agent's default model from adapterConfig */
  defaultModel: string | null;
  /** Currently selected model override */
  selectedModel: string | null;
  /**
   * Retained for caller compatibility. Sprint 2A removed the API-mode model
   * picker; CLI tools manage their own model selection. Still accepted by
   * WorkspaceTimeline so it can wire up `setModelOverride`, but not called
   * from within this component anymore. Optional from Sprint 2A onward.
   */
  onModelChange?: (model: string | null) => void;
  onSend: () => void;
  onAttach?: () => void;
  /** Inserts an @ at the caret and focuses the editor (approved mock §1). */
  onMention?: () => void;
  showModelLabel?: boolean;
  sendDisabled: boolean;
  sendPending: boolean;
  /** Action label states what actually happens: Send / Send & wake / Comment. */
  sendLabel?: string;
  activeRun?: boolean;
  closedTask?: boolean;
  reopenRequested?: boolean;
  onReopenChange?: (value: boolean) => void;
}

export function ChatbarControls({
  adapterType,
  defaultModel,
  selectedModel,
  onSend,
  onAttach,
  onMention,
  showModelLabel = true,
  sendDisabled,
  sendPending,
  sendLabel = "Send",
  closedTask = false,
  reopenRequested = false,
  onReopenChange,
}: ChatbarControlsProps) {
  // Sprint 2A: API adapters removed — model is read-only now; CLI tool picks
  // its own model so onModelChange is no longer wired.
  const effectiveModel = selectedModel ?? defaultModel ?? "";
  const displayModel = effectiveModel ? shortModelName(effectiveModel) : adapterType;

  return (
    <div className="flex items-center gap-1 px-2 py-1.5">
      {/* Common set (mock v2): 📎 attach · @ mention · 🎤 voice placeholder */}
      <ComposerIconButton
        onClick={onAttach}
        disabled={!onAttach}
        title="Attach file"
        aria-label="Attach file"
      >
        <Paperclip className="h-4 w-4" />
      </ComposerIconButton>

      {onMention && (
        <ComposerIconButton
          onClick={onMention}
          title="Mention someone"
          aria-label="Mention someone"
          data-testid="workspace-chatbar-mention-button"
        >
          <AtSign className="h-4 w-4" />
        </ComposerIconButton>
      )}

      <ComposerIconButton title="Voice input" aria-label="Voice input" comingSoon>
        <Mic className="h-4 w-4" />
      </ComposerIconButton>

      {/* Interrupt moved BELOW the card frame (approved mock §4) — rendered by
          the host. Re-open stays here (closed tasks have no run to interrupt). */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        {closedTask && onReopenChange && (
          <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={reopenRequested}
              onChange={(event) => onReopenChange(event.target.checked)}
              className="rounded border-border"
            />
            Re-open task
          </label>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Config chip right-aligned before the action (mock v2) — read-only
          model/adapter label; CLI adapters manage model selection themselves. */}
      {showModelLabel && (
        <span className="text-[11px] text-muted-foreground px-2 py-0.5 bg-muted/40 border border-border rounded-md shrink-0">
          {displayModel}
        </span>
      )}

      {/* Right: send button — brand red is reserved for the primary Send/Stop
          action (Quiet Operator, scope §14). */}
      <Button
        size="sm"
        className="h-7 text-xs px-3 bg-brand text-white hover:bg-brand/90"
        disabled={sendDisabled}
        onClick={onSend}
      >
        {sendPending ? (
          "Sending..."
        ) : (
          <>
            {sendLabel}
            <Send className="h-3 w-3 ml-1.5" />
          </>
        )}
      </Button>
    </div>
  );
}
