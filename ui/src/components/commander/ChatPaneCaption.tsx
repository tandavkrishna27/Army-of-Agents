import { PanelLeft, PanelRight, PanelRightClose } from "lucide-react";
import { timeAgo } from "../../lib/timeAgo";

interface ChatPaneCaptionProps {
  title: string;
  messageCount: number;
  updatedAt?: string;
  onOpenSessions?: () => void;
  /** Whether the viewer panel is currently open. */
  viewerOpen?: boolean;
  /** Called when the "Open preview" / "Hide preview" toggle is clicked. */
  onToggleViewer?: () => void;
}

export function ChatPaneCaption({
  title,
  messageCount,
  updatedAt,
  onOpenSessions,
  viewerOpen,
  onToggleViewer,
}: ChatPaneCaptionProps) {
  const relTime = updatedAt ? timeAgo(updatedAt) : null;
  const PreviewIcon = viewerOpen ? PanelRightClose : PanelRight;
  const previewLabel = viewerOpen ? "Hide preview" : "Open preview";

  return (
    <div className="h-[42px] flex items-center gap-2 px-5 border-b border-border-soft bg-bg shrink-0">
      {/* Mobile/tablet (< 1024px): Sessions button opens the left drawer.
          `lg:hidden` so it stays visible across the whole drawer-layout range
          (mobile + tablet) and disappears exactly when the inline sidebar
          takes over at the desktop tier. */}
      {onOpenSessions && (
        <button
          type="button"
          data-commander-touch
          onClick={onOpenSessions}
          className="lg:hidden p-1 rounded text-dim hover:bg-hd hover:text-text transition-colors shrink-0"
          aria-label="Open sessions"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      )}

      {/* Title + meta */}
      <div className="flex flex-col justify-center min-w-0 flex-1">
        <span className="text-[0.95rem] font-semibold leading-tight truncate text-text">
          {title}
        </span>
        <span className="text-[0.7rem] text-dim leading-tight">
          {relTime && (
            <>
              <span>{relTime}</span>
              <span className="mx-1 text-very-dim">·</span>
            </>
          )}
          <span className="font-mono">{messageCount}</span>
          <span> msgs</span>
        </span>
      </div>

      {/* "Open preview" / "Hide preview" toggle — right side.
          Only rendered when a handler is provided (Phase 3 wires this from
          InternalAgentPanel). Hidden until a conversation exists because the
          viewer is meaningless with no active conversation; the parent
          already gates `ChatPaneCaption` behind `conversationId`. */}
      {onToggleViewer && (
        <button
          type="button"
          onClick={onToggleViewer}
          data-testid="commander-open-preview"
          aria-label={previewLabel}
          aria-pressed={viewerOpen ?? false}
          title={previewLabel}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-dim hover:bg-hd hover:text-text transition-colors shrink-0 text-xs"
        >
          <PreviewIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{previewLabel}</span>
        </button>
      )}
    </div>
  );
}
