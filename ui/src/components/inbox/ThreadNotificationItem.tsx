import { Link } from "@/lib/router";
import {
  AlertTriangle,
  FileText,
  HelpCircle,
  MessageSquare,
  Split,
  Sparkles,
} from "lucide-react";
import type { Notification } from "@armyofagents/shared";
import { timeAgo } from "../../lib/timeAgo";

/**
 * Renders a single thread-coordination notification row in Inbox.
 *
 * Phase 1 Phase E batch 3 (T23): the 5 new notification types all link to a
 * discussion thread. The contextual payload (artifact title, agent name, etc.)
 * is encoded in the existing `title`/`message` text fields on the notifications
 * table — the renderer reads them as plain strings rather than parsing a JSON
 * `data` blob. This keeps the schema unchanged for now.
 *
 * `notification.relatedEntityType === "discussion"` is assumed for every type
 * in this component (5/5). If a future producer sets `relatedEntityType=null`
 * the link falls back to the inbox page itself instead of throwing.
 */

const TYPE_META: Record<
  string,
  {
    Icon: typeof MessageSquare;
    tone: string;
    label: string;
  }
> = {
  "thread.scope_proposal_posted": {
    Icon: FileText,
    tone: "text-blue-500",
    label: "Scope proposal",
  },
  "thread.artifact_needs_review": {
    Icon: Sparkles,
    tone: "text-emerald-500",
    label: "Artifact ready",
  },
  "thread.crew_failed": {
    Icon: AlertTriangle,
    tone: "text-amber-500",
    label: "Crew failed",
  },
  "thread.spinoff_suggested": {
    Icon: Split,
    tone: "text-purple-500",
    label: "Spinoff suggested",
  },
  "thread.human_input_needed": {
    Icon: HelpCircle,
    tone: "text-orange-500",
    label: "Input needed",
  },
};

interface ThreadNotificationItemProps {
  notification: Notification;
  onClick?: (notification: Notification) => void;
}

export function ThreadNotificationItem({
  notification,
  onClick,
}: ThreadNotificationItemProps) {
  const meta = TYPE_META[notification.type] ?? {
    Icon: MessageSquare,
    tone: "text-muted-foreground",
    label: "Thread",
  };
  const { Icon, tone, label } = meta;

  // Defensive: only build a real link if we have a discussion target.
  const threadId =
    notification.relatedEntityType === "discussion"
      ? notification.relatedEntityId
      : null;
  const href = threadId ? `/discussions/${threadId}` : "/inbox";

  return (
    <Link
      to={href}
      onClick={() => onClick?.(notification)}
      data-testid={`thread-notification-${notification.type}`}
      data-notification-id={notification.id}
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50 no-underline text-inherit"
    >
      <Icon className={`h-4 w-4 shrink-0 ${tone}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {notification.title}
          </span>
          <span
            className={`shrink-0 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-medium ${tone}`}
          >
            {label}
          </span>
        </div>
        {notification.message && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {notification.message}
          </div>
        )}
        <div className="mt-0.5 text-xs text-muted-foreground">
          {timeAgo(notification.createdAt)}
        </div>
      </div>
    </Link>
  );
}

/**
 * The 5 Phase 1 thread-coordination types. Used by Inbox to filter the
 * full notification list down to the thread-coordination subset.
 */
export const THREAD_NOTIFICATION_TYPES = [
  "thread.scope_proposal_posted",
  "thread.artifact_needs_review",
  "thread.crew_failed",
  "thread.spinoff_suggested",
  "thread.human_input_needed",
] as const;

export type ThreadNotificationType = (typeof THREAD_NOTIFICATION_TYPES)[number];

export function isThreadNotification(notification: Notification): boolean {
  return (THREAD_NOTIFICATION_TYPES as readonly string[]).includes(
    notification.type,
  );
}
