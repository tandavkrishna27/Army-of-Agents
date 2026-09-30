import { useQuery } from "@tanstack/react-query";
import { Brain } from "lucide-react";
import type { MemoryItem } from "@armyofagents/shared";
import { memoryApi } from "../../../api/memory";
import { queryKeys } from "../../../lib/queryKeys";
import { LAYER_LABELS, LAYER_TONE } from "../../../lib/memoryItemView";
import { MemoryChip } from "../../memory/MemoryChip";
import { WidgetShell } from "./WidgetShell";
import { WidgetEmpty, WidgetLoading, WidgetOverflow } from "./WidgetStates";
import { WidgetRowLink } from "./WidgetRowLink";
import { rowsForSize } from "./widgetSizing";
import type { WidgetProps } from "./types";

export function MemoryReviewWidget({ companyId, editing, size }: WidgetProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.memory.pending(companyId),
    queryFn: () => memoryApi.listPending(companyId),
    enabled: !!companyId,
  });
  const allItems = data?.items ?? [];
  const maxRows = rowsForSize(size);
  const items = allItems.slice(0, maxRows);
  const overflow = allItems.length - items.length;

  return (
    <WidgetShell title="Memory review" icon={Brain} to="/memory" editing={editing}>
      {isLoading ? (
        <WidgetLoading />
      ) : isError || !data ? (
        // Memory is team-readable by design (the memory-pending route's
        // assertMemoryAccess(...,"read") allows every role, including
        // team_member — registry's requiresFounder only hides this widget
        // from the Add-widget tray, it doesn't gate the data), so this arm
        // is a genuine fetch failure, never a role-based 403.
        <WidgetEmpty icon={Brain} message="Couldn't load memory" />
      ) : items.length === 0 ? (
        <WidgetEmpty icon={Brain} message="No memory to review" />
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {items.map((m: MemoryItem) => (
            <WidgetRowLink
              key={m.id}
              to={`/memory/explore?item=${m.id}&type=memory_item`}
              editing={editing}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-inherit no-underline transition-colors hover:bg-accent/50"
            >
              <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{m.title}</span>
              {m.layer && (
                <MemoryChip label={LAYER_LABELS[m.layer]} tone={LAYER_TONE[m.layer]} className="shrink-0" />
              )}
            </WidgetRowLink>
          ))}
          <WidgetOverflow count={overflow} />
        </div>
      )}
    </WidgetShell>
  );
}
