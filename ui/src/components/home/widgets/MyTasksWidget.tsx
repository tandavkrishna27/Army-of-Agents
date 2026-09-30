import { useQuery } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import type { Issue } from "@armyofagents/shared";
import { issuesApi } from "../../../api/issues";
import { queryKeys } from "../../../lib/queryKeys";
import { useDialog } from "../../../context/DialogContext";
import { WidgetShell } from "./WidgetShell";
import { WidgetEmpty, WidgetLoading, WidgetOverflow } from "./WidgetStates";
import { WidgetRowLink } from "./WidgetRowLink";
import { rowsForSize } from "./widgetSizing";
import type { WidgetProps } from "./types";

const TERMINAL = new Set(["done", "cancelled"]);

export function MyTasksWidget({ companyId, editing, size }: WidgetProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.issues.listAssignedToMe(companyId),
    queryFn: () => issuesApi.list(companyId, { assigneeUserId: "me" }),
    enabled: !!companyId,
  });
  const { openNewIssue } = useDialog();
  const allTasks = (data ?? []).filter((t: Issue) => !TERMINAL.has(t.status));
  const maxRows = rowsForSize(size);
  const tasks = allTasks.slice(0, maxRows);
  const overflow = allTasks.length - tasks.length;
  return (
    <WidgetShell title="My tasks" icon={ListChecks} to="/issues" editing={editing}>
      {isLoading ? (
        <WidgetLoading />
      ) : isError ? (
        <WidgetEmpty icon={ListChecks} message="Couldn't load your tasks" />
      ) : tasks.length === 0 ? (
        // CTA is hidden while editing so an add-dialog can't fire mid-drag (review P2).
        <WidgetEmpty
          icon={ListChecks}
          message="No tasks assigned to you"
          ctaLabel={editing ? undefined : "+ New task"}
          onCta={editing ? undefined : openNewIssue}
        />
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {tasks.map((t: Issue) => (
            <WidgetRowLink
              key={t.id}
              to={`/issues/${t.identifier ?? t.id}`}
              editing={editing}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-inherit no-underline transition-colors hover:bg-accent/50"
            >
              <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              <span className="shrink-0 text-xs capitalize text-muted-foreground">{t.status.replace(/_/g, " ")}</span>
            </WidgetRowLink>
          ))}
          <WidgetOverflow count={overflow} />
        </div>
      )}
    </WidgetShell>
  );
}
