import { Inbox } from "lucide-react";
import { useHomeSummary } from "../../../hooks/useHomeSummary";
import { buildActionGroups, allocateActionGroups } from "../actionQueue";
import { ActionQueueGroup } from "./ActionQueueGroup"; // move the component here
import { WidgetShell } from "./WidgetShell";
import { WidgetEmpty, WidgetLoading, WidgetOverflow } from "./WidgetStates";
import { rowsForSize } from "./widgetSizing";
import type { WidgetProps } from "./types";

export function ActionQueueWidget({ companyId, editing, size }: WidgetProps) {
  const { data, isLoading, isError } = useHomeSummary(companyId);
  const groups = data ? buildActionGroups(data) : [];
  const { allocated, overflow } = allocateActionGroups(groups, rowsForSize(size));
  return (
    <WidgetShell title="Action queue" icon={Inbox} to="/issues" editing={editing}>
      {isLoading ? (
        <WidgetLoading />
      ) : isError ? (
        <WidgetEmpty icon={Inbox} message="Couldn't load" />
      ) : groups.length === 0 ? (
        <WidgetEmpty icon={Inbox} message="Nothing needs review — all clear" />
      ) : (
        <div className="space-y-3">
          {allocated.map(({ group, maxItems }) => (
            <ActionQueueGroup key={group.id} group={group} editing={editing} maxItems={maxItems} />
          ))}
          <WidgetOverflow count={overflow} />
        </div>
      )}
    </WidgetShell>
  );
}
