/** Approved mock §5 offline strip. `state` is the surface's MAPPED connection
 *  state: useLiveUpdates().connectionState is "connecting"|"open"|"reconnecting"|"offline"
 *  — surfaces map BOTH open AND connecting → "connected" (no strip) so the
 *  composer never flashes "Reconnecting…" on initial page load. */
import { CloudOff } from "lucide-react";

export type ComposerConnectionState = "connected" | "reconnecting" | "offline";

export function ComposerOfflineStrip({ state }: { state: ComposerConnectionState }) {
  if (state === "connected") return null;
  return (
    <div
      data-testid="composer-offline-strip"
      className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
    >
      <CloudOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {state === "offline"
        ? "You're offline — draft saved. We'll send when you're back."
        : "Reconnecting… your draft is saved."}
    </div>
  );
}

/** Map useLiveUpdates().connectionState to the strip's tri-state. */
export function toComposerConnectionState(live: string): ComposerConnectionState {
  if (live === "offline") return "offline";
  if (live === "reconnecting") return "reconnecting";
  return "connected"; // "open" and "connecting" both render no strip
}
