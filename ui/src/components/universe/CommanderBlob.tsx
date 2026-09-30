import type { CSSProperties } from "react";
import { EyeOff, Mic, Play, Volume2 } from "lucide-react";

/** Truthful voice state (E1.5/2). E3.2 owns real transitions; until the port is
 * configured the blob shows "unavailable" and never fakes a connection. */
export type VoiceState =
  | "unavailable"
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking";

export interface CommanderBlobProps {
  size?: number;
  voiceState?: VoiceState;
  /** Blob click = the Commander primary (restore/forward/tuck chat). */
  onPrimary?: () => void;
  onStartVoice?: () => void;
  onHide?: () => void;
}

export function CommanderBlob({
  size = 128,
  voiceState = "unavailable",
  onPrimary,
  onStartVoice,
  onHide,
}: CommanderBlobProps) {
  const voiceReady = voiceState !== "unavailable";
  return (
    <div
      className="universe-commander-blob-wrap"
      style={{ ["--blob-size" as string]: `${size}px` } as CSSProperties}
    >
      <button
        type="button"
        className="universe-commander-blob"
        aria-label="Commander"
        data-voice={voiceState}
        onClick={onPrimary}
      >
        <span className="universe-commander-blob-core" aria-hidden />
      </button>
      <div
        className="universe-commander-blob-controls"
        role="group"
        aria-label="Commander controls"
      >
        <button
          type="button"
          onClick={onStartVoice}
          disabled={!voiceReady}
          aria-label={voiceReady ? "Start voice" : "Voice unavailable"}
          title={voiceReady ? "Start voice" : "Voice unavailable"}
        >
          <Play size={15} aria-hidden />
        </button>
        <button type="button" disabled aria-label="Microphone">
          <Mic size={15} aria-hidden />
        </button>
        <button type="button" disabled aria-label="Speaker">
          <Volume2 size={15} aria-hidden />
        </button>
        <button type="button" onClick={onHide} aria-label="Hide blob">
          <EyeOff size={15} aria-hidden />
        </button>
      </div>
    </div>
  );
}
