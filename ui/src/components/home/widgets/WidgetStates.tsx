import type { ComponentType } from "react";

/** Centered empty state for a widget body (inside WidgetShell). Optional CTA. */
export function WidgetEmpty({ icon: Icon, message, ctaLabel, onCta }: {
  icon: ComponentType<{ className?: string }>;
  message: string;
  ctaLabel?: string;
  onCta?: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-2 text-center text-muted-foreground">
      <Icon className="h-6 w-6 opacity-70" aria-hidden />
      <p className="text-sm">{message}</p>
      {ctaLabel && onCta && (
        <button type="button" onClick={onCta} className="rounded-md border border-border px-2.5 py-1 text-xs text-primary transition-colors hover:bg-accent/50">
          {ctaLabel}
        </button>
      )}
    </div>
  );
}

/** Minimal loading placeholder for a widget body — distinct from empty so a
 *  populated widget never flashes its empty state before its data resolves. */
export function WidgetLoading() {
  return <div className="flex h-full items-center justify-center"><span className="text-xs text-muted-foreground">Loading…</span></div>;
}

/**
 * "+N more" tail row for a truncated list — lets the user know there's more
 * beyond what the tile's current size can show (see widgetSizing.ts's
 * `rowsForSize`). Renders nothing when there's no overflow, so call sites can
 * render it unconditionally (`<WidgetOverflow count={overflow} />`) instead
 * of each re-deriving their own `overflow > 0 &&` guard.
 */
export function WidgetOverflow({ count }: { count: number }) {
  if (count <= 0) return null;
  return <div className="px-4 py-2 text-xs text-muted-foreground">+{count} more</div>;
}
