/** absolute inset-0 INSIDE the frame — the frame stays overflow-free (P1). */
import { COMPOSER_MAX_ATTACHMENT_BYTES } from "@armyofagents/shared";

const MB = Math.round(COMPOSER_MAX_ATTACHMENT_BYTES / (1024 * 1024));

export function ComposerDropOverlay({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div
      data-testid="composer-drop-overlay"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-brand bg-background/85 text-sm font-medium text-foreground"
    >
      Drop files to attach — up to {MB} MB each
    </div>
  );
}
