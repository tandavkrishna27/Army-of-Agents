import { Activity } from "lucide-react";
import { useHomeSummary } from "../../../hooks/useHomeSummary";
import { timeAgo } from "../../../lib/timeAgo";
import { entityLink } from "../../../lib/activityFormat";
import { formatAction, activityEntityName, collapseActivity } from "../activityFormat";
import { WidgetShell } from "./WidgetShell";
import { WidgetEmpty, WidgetLoading, WidgetOverflow } from "./WidgetStates";
import { WidgetRowLink } from "./WidgetRowLink";
import { rowsForSize } from "./widgetSizing";
import type { WidgetProps } from "./types";

export function ActivityFeedWidget({ companyId, editing, size }: WidgetProps) {
  const { data, isLoading, isError } = useHomeSummary(companyId);
  const allActivity = collapseActivity(data?.recentActivity ?? []);
  const maxRows = rowsForSize(size);
  const activity = allActivity.slice(0, maxRows);
  const overflow = allActivity.length - activity.length;
  return (
    <WidgetShell title="Today's activity" icon={Activity} to="/activity" editing={editing}>
      {isLoading ? (
        <WidgetLoading />
      ) : isError ? (
        <WidgetEmpty icon={Activity} message="Couldn't load activity" />
      ) : activity.length === 0 ? (
        <WidgetEmpty icon={Activity} message="Agent activity will show up here as your crew starts working." />
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {activity.map((item) => (
            <WidgetRowLink
              key={item.id}
              to={entityLink(item.entityType, item.entityId)}
              editing={editing}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-inherit no-underline transition-colors hover:bg-accent/50"
            >
              <Activity className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted-foreground">{formatAction(item)}</span>{" "}
                <span className="font-medium">{activityEntityName(item)}</span>
                {item.count > 1 && <span className="text-muted-foreground"> ×{item.count}</span>}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(item.createdAt)}</span>
            </WidgetRowLink>
          ))}
          <WidgetOverflow count={overflow} />
        </div>
      )}
    </WidgetShell>
  );
}
