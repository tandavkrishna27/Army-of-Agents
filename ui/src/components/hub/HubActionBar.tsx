import {
  Archive,
  CheckCircle2,
  Clock3,
  EyeOff,
  MessageCircleQuestion,
  RotateCcw,
  Share2,
  UserCheck,
  UserX,
} from "lucide-react";
import { HUB_SOURCE_MIRRORED_TYPES } from "@armyofagents/shared";
import type { HubItemListRow } from "@/api/hub-items";
import { Button } from "@/components/ui/button";

interface HubActionBarProps {
  item: HubItemListRow;
  onDismiss: (itemId: string) => void;
  onSnooze: (itemId: string) => void;
  onLifecycleAction: (
    item: HubItemListRow,
    action: "resolve" | "archive" | "claim" | "release",
  ) => void;
  onMarkUnread?: (itemId: string) => void;
  undoAction?: { label: string; onUndo: () => void } | null;
}

/**
 * Slim contextual action bar for the active hub tab's item. Source-backed
 * decision rows mirror their source lifecycle, so generic resolve/archive is
 * hidden while open; runtime decisions also skip claim/release.
 */
export function HubActionBar({
  item,
  onDismiss,
  onSnooze,
  onLifecycleAction,
  onMarkUnread,
  undoAction,
}: HubActionBarProps) {
  const isRuntimeDecision = item.semanticType === "agent_runtime_decision";
  const isMirrored = (HUB_SOURCE_MIRRORED_TYPES as readonly string[]).includes(
    item.semanticType,
  );
  const showResolveArchive = !(isRuntimeDecision || (isMirrored && item.status === "open"));
  const showClaimRelease = !isRuntimeDecision;

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/40 px-4 py-2"
      data-testid="hub-action-bar"
    >
      {undoAction ? (
        <div className="mr-1 inline-flex min-w-0 items-center gap-2 rounded border border-border bg-card px-2 py-1 text-xs text-muted-foreground">
          <span className="truncate">{undoAction.label}</span>
          <Button type="button" variant="ghost" size="sm" onClick={undoAction.onUndo}>
            <RotateCcw className="size-4" aria-hidden="true" />
            Undo {undoAction.label}
          </Button>
        </div>
      ) : null}
      {item.readAt && onMarkUnread ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => onMarkUnread(item.id)}>
          <EyeOff className="size-4" aria-hidden="true" />
          Mark unread
        </Button>
      ) : null}
      <Button type="button" variant="secondary" size="sm" onClick={() => onDismiss(item.id)}>
        <EyeOff className="size-4" aria-hidden="true" />
        Dismiss
      </Button>
      <Button type="button" variant="secondary" size="sm" onClick={() => onSnooze(item.id)}>
        <Clock3 className="size-4" aria-hidden="true" />
        Snooze
      </Button>
      {showResolveArchive ? (
        <>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onLifecycleAction(item, "resolve")}
          >
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Resolve
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onLifecycleAction(item, "archive")}
          >
            <Archive className="size-4" aria-hidden="true" />
            Archive
          </Button>
        </>
      ) : null}
      {showClaimRelease && item.ownerPool === "board" && !item.claimedByUserId ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onLifecycleAction(item, "claim")}
        >
          <UserCheck className="size-4" aria-hidden="true" />
          Claim
        </Button>
      ) : null}
      {showClaimRelease && item.claimedByUserId ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onLifecycleAction(item, "release")}
        >
          <UserX className="size-4" aria-hidden="true" />
          Release
        </Button>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled
          aria-label="Route or delegate (coming soon)"
          title="Coming soon"
        >
          <Share2 className="size-4" aria-hidden="true" />
          Route / Delegate
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled
          aria-label="Ask Commander to weigh in (coming soon)"
          title="Coming soon"
        >
          <MessageCircleQuestion className="size-4" aria-hidden="true" />
          Ask Commander to weigh in
        </Button>
      </div>
    </div>
  );
}
