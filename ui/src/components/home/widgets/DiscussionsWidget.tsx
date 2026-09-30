import { useQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import type { DiscussionListItem } from "../../../api/discussions";
import { discussionsApi } from "../../../api/discussions";
import { queryKeys } from "../../../lib/queryKeys";
import { useDialog } from "../../../context/DialogContext";
import { WidgetShell } from "./WidgetShell";
import { WidgetEmpty, WidgetLoading, WidgetOverflow } from "./WidgetStates";
import { WidgetRowLink } from "./WidgetRowLink";
import { rowsForSize } from "./widgetSizing";
import type { WidgetProps } from "./types";

/**
 * Recency for sorting: lastEntryAt when the thread has entries, else
 * createdAt (a brand-new discussion has no entries yet — see
 * DiscussionListItem, which has no separate updatedAt field).
 */
function recencyMs(d: DiscussionListItem): number {
  return new Date(d.lastEntryAt ?? d.createdAt).getTime();
}

export function DiscussionsWidget({ companyId, editing, size }: WidgetProps) {
  const { data, isLoading, isError } = useQuery({
    // Distinct from queryKeys.discussions.list(companyId) alone (used by the
    // full Discussions page with its own filter set) so this widget's
    // narrower {status:"active"} fetch never collides with that cache entry —
    // same pattern as DiscussionDetail.tsx's "related" key extension.
    queryKey: [...queryKeys.discussions.list(companyId), "home-widget", "active"],
    queryFn: () => discussionsApi.list(companyId, { status: "active" }),
    enabled: !!companyId,
  });
  const { openDiscussionCapture } = useDialog();

  // The server ignores sortBy/sortOrder/limit on this list route today (it
  // hardcodes limit:50/offset:0 — verified in server/src/routes/discussions.ts),
  // so recency ordering and the size-driven row cap are both done here
  // client-side.
  const allDiscussions = [...(data?.discussions ?? [])].sort((a, b) => recencyMs(b) - recencyMs(a));
  const maxRows = rowsForSize(size);
  const discussions = allDiscussions.slice(0, maxRows);
  const overflow = allDiscussions.length - discussions.length;

  return (
    <WidgetShell title="Discussions" icon={MessagesSquare} to="/discussions" editing={editing}>
      {isLoading ? (
        <WidgetLoading />
      ) : isError || !data ? (
        <WidgetEmpty icon={MessagesSquare} message="Couldn't load discussions" />
      ) : discussions.length === 0 ? (
        // CTA is hidden while editing so an add-dialog can't fire mid-drag (matches the other widgets' empty-state CTAs).
        <WidgetEmpty
          icon={MessagesSquare}
          message="No discussions yet"
          ctaLabel={editing ? undefined : "+ New discussion"}
          onCta={editing ? undefined : openDiscussionCapture}
        />
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {discussions.map((d) => (
            <WidgetRowLink
              key={d.id}
              to={`/discussions/${d.id}`}
              editing={editing}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-inherit no-underline transition-colors hover:bg-accent/50"
            >
              <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{d.title}</div>
                <div className="text-xs text-muted-foreground">
                  {d.entryCount} entries{d.pendingItemCount > 0 ? ` · ${d.pendingItemCount} pending` : ""}
                </div>
              </div>
            </WidgetRowLink>
          ))}
          <WidgetOverflow count={overflow} />
        </div>
      )}
    </WidgetShell>
  );
}
