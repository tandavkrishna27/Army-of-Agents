/**
 * ComposerIconButton — THE toolbar icon button for every composer surface.
 *
 * Approved mock v2 locks one visual for 📎 attach / @ mention / 🎤 voice on
 * all four chat boxes (Discussion, Commander, Workspace chatbar, Task
 * Comments). Surfaces must not hand-roll their own icon-button classes —
 * consume this so drift can't recur (live QA 2026-07-16 found four different
 * paddings/shapes across the surfaces).
 *
 * `comingSoon` renders the dimmed placeholder state (mock v2: the mic is
 * present everywhere for placement, disabled until the feature ships).
 */
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export interface ComposerIconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Dimmed "coming soon" placeholder — disabled with a hint tooltip. */
  comingSoon?: boolean;
}

export const ComposerIconButton = forwardRef<
  HTMLButtonElement,
  ComposerIconButtonProps
>(function ComposerIconButton(
  { comingSoon = false, className, disabled, title, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || comingSoon}
      title={comingSoon ? (title ? `${title} — coming soon` : "Coming soon") : title}
      className={cn(
        "shrink-0 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors",
        comingSoon
          ? "opacity-40 cursor-not-allowed"
          : "hover:text-foreground hover:bg-muted/60 disabled:opacity-40 disabled:cursor-not-allowed",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
