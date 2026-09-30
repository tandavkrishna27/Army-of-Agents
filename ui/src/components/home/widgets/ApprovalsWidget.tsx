import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import type { Approval, WorkQuestion } from "@armyofagents/shared";
import { approvalsApi } from "../../../api/approvals";
import { workQuestionsApi } from "../../../api/work-questions";
import { queryKeys } from "../../../lib/queryKeys";
import { typeLabel } from "../../ApprovalPayload";
import { WidgetShell } from "./WidgetShell";
import { WidgetEmpty, WidgetLoading, WidgetOverflow } from "./WidgetStates";
import { WidgetRowLink } from "./WidgetRowLink";
import { rowsForSize } from "./widgetSizing";
import type { WidgetProps } from "./types";

interface WaitingRow {
  key: string;
  label: string;
  /** Deep-link target, or null when the row has no resolvable entity (never render /issues/null). */
  to: string | null;
}

function approvalRow(a: Approval): WaitingRow {
  return { key: `approval-${a.id}`, label: typeLabel[a.type] ?? a.type, to: `/approvals/${a.id}` };
}

function questionRow(q: WorkQuestion): WaitingRow {
  const target = q.issueIdentifierSnapshot ?? q.issueId;
  return {
    key: `question-${q.id}`,
    label: q.title || q.question,
    to: target ? `/issues/${target}` : null,
  };
}

export function ApprovalsWidget({ companyId, editing, size }: WidgetProps) {
  const { data: approvals, isLoading: aLoading, isError: aIsError } = useQuery({
    queryKey: queryKeys.approvals.list(companyId, "pending"),
    queryFn: () => approvalsApi.list(companyId, "pending"),
    enabled: !!companyId,
  });
  const { data: questions, isLoading: qLoading, isError: qIsError } = useQuery({
    queryKey: ["work-questions", companyId, "mine-open"],
    queryFn: () => workQuestionsApi.list(companyId, { scope: "mine", status: "open" }),
    enabled: !!companyId,
  });
  // Require BOTH queries settled successfully — an empty array is truthy, so a
  // `&&` on data alone would render a misleading partial list on a one-sided
  // failure. Either query still in flight -> loading; either failed -> error
  // (never a partial/misleading list).
  const isLoading = aLoading || qLoading;
  const isError = aIsError || qIsError;

  const rows: WaitingRow[] =
    !approvals || !questions ? [] : [...approvals.map(approvalRow), ...questions.map(questionRow)];
  const maxRows = rowsForSize(size);
  const visible = rows.slice(0, maxRows);
  const overflow = rows.length - visible.length;

  return (
    <WidgetShell title="Waiting on you" icon={Bell} to="/inbox" editing={editing}>
      {isLoading ? (
        <WidgetLoading />
      ) : isError || !approvals || !questions ? (
        <WidgetEmpty icon={Bell} message="Couldn't load" />
      ) : rows.length === 0 ? (
        <WidgetEmpty icon={Bell} message="Nothing waiting on you" />
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {visible.map((row) => (
            <WidgetRowLink
              key={row.key}
              to={row.to}
              editing={editing}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-inherit no-underline transition-colors hover:bg-accent/50"
            >
              <Bell className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
            </WidgetRowLink>
          ))}
          <WidgetOverflow count={overflow} />
        </div>
      )}
    </WidgetShell>
  );
}
