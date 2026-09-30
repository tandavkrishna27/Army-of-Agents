import type { CSSProperties, DOMAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ComposerDensity = "comfortable" | "compact" | "mobile";
export type ComposerChrome = "bare" | "card";

export interface ComposerFrameProps {
  density?: ComposerDensity;
  /**
   * Visual treatment. "card" = the Quiet Operator bordered focus-glow card
   * (derived from Commander's proven chrome + shadow-sm). "bare" (default)
   * leaves styling to the host during migration.
   *
   * The card variant must NEVER gain an overflow property: mention popovers
   * render `absolute bottom-full` INSIDE the frame (CommanderInput,
   * EntryAutocompleteList) and would be clipped — a breakage Playwright's
   * toBeVisible cannot detect.
   */
  chrome?: ComposerChrome;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  "data-testid"?: string;
  "data-thread-id"?: string;
  "data-reply"?: string;
  "data-parent-entry-id"?: string;
  /**
   * Frame-wide drag-drop handlers (see useComposerDragDrop). Optional —
   * surfaces that don't support drop-to-attach omit this.
   */
  dragHandlers?: Pick<
    DOMAttributes<HTMLDivElement>,
    "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop"
  >;
}

/** Shared Quiet Operator frame: status/context, tray, editor, controls, error. */
export function ComposerFrame({ density = "comfortable", chrome = "bare", children, className, style, "data-testid": testId, "data-thread-id": threadId, "data-reply": reply, "data-parent-entry-id": parentEntryId, dragHandlers }: ComposerFrameProps) {
  return (
    <div
      data-composer-frame
      data-density={density}
      data-chrome={chrome}
      data-testid={testId}
      data-thread-id={threadId}
      data-reply={reply}
      data-parent-entry-id={parentEntryId}
      style={style}
      {...dragHandlers}
      className={cn(
        // "relative" anchors ComposerDropOverlay's absolute inset-0 — never
        // add an overflow class here (mention popovers render absolute
        // bottom-full INSIDE the frame and would be clipped).
        "composer-frame relative flex min-w-0 flex-col",
        // Dark-theme perceivability: border-border on bg-background is near-black
        // on near-black (user-verified invisible). border-strong + the field
        // surface tone give the card real contrast against both the pane and
        // the host strip, matching the LobbyCompanyCard prominence pattern.
        chrome === "card" &&
          "rounded-lg border border-border-strong bg-field shadow-sm focus-within:ring-2 focus-within:ring-brand-focus-ring focus-within:border-brand transition-shadow",
        density === "comfortable" && "gap-0",
        density === "compact" && "text-[0.95em]",
        density === "mobile" && "pb-[env(safe-area-inset-bottom)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
