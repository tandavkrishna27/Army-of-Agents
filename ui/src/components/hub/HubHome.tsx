import type { HubItemListRow } from "@/api/hub-items";
import type { HubAutopilotActionRow, HubAutopilotPolicy, HubLane } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";

interface HubHomeProps {
  counts: { open: number; unread: number };
  items: HubItemListRow[];
  autopilotPolicy: HubAutopilotPolicy;
  autopilotActions: HubAutopilotActionRow[];
  visibleLanes?: HubLane[];
  showAutopilotEntry?: boolean;
  onLaneChange: (lane: HubLane) => void;
  onUndoAutopilotAction?: (action: HubAutopilotActionRow) => void;
}

export function HubHome({
  counts,
  items,
  autopilotPolicy,
  autopilotActions,
  visibleLanes,
  showAutopilotEntry = true,
  onLaneChange,
  onUndoAutopilotAction,
}: HubHomeProps) {
  const topItem = items[0] ?? null;
  const canShowLane = (lane: HubLane) => !visibleLanes || visibleLanes.includes(lane);
  const canUndo = (action: HubAutopilotActionRow) =>
    Boolean(
      action.hubItemId &&
        action.itemVersion != null &&
        action.undoDeadline &&
        Date.parse(action.undoDeadline) > Date.now(),
    );
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
      <div className="grid grid-cols-2 gap-3">
        <div className="border-b border-border pb-3">
          <div className="text-xs uppercase text-muted-foreground">Open</div>
          <div className="mt-1 text-2xl font-semibold">{counts.open}</div>
        </div>
        <div className="border-b border-border pb-3">
          <div className="text-xs uppercase text-muted-foreground">Unread</div>
          <div className="mt-1 text-2xl font-semibold">{counts.unread}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {canShowLane("waiting_on_you") ? (
          <Button type="button" variant="secondary" onClick={() => onLaneChange("waiting_on_you")}>
            Waiting on you
          </Button>
        ) : null}
        {canShowLane("notifications") ? (
          <Button type="button" variant="secondary" onClick={() => onLaneChange("notifications")}>
            Notifications
          </Button>
        ) : null}
        {canShowLane("suggestions") ? (
          <Button type="button" variant="secondary" onClick={() => onLaneChange("suggestions")}>
            Suggestions
          </Button>
        ) : null}
      </div>
      <div className="border-t border-border pt-4">
        <div className="text-sm font-medium">Needs you most</div>
        <div className="mt-2 text-sm text-muted-foreground">
          {topItem ? topItem.title : "Nothing needs attention right now."}
        </div>
        {topItem?.curationReason || topItem?.curationPriorityReason ? (
          <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {topItem.curationReason ?? topItem.curationPriorityReason}
          </div>
        ) : null}
      </div>
      {showAutopilotEntry ? (
        <div className="mt-auto border-t border-border pt-4">
          <div className="text-sm font-medium">Autopilot</div>
          <div className="mt-2 flex items-center justify-between gap-3 text-sm">
            <span>{autopilotModeLabel(autopilotPolicy.mode)}</span>
            <span className="text-xs text-muted-foreground">
              {autopilotPolicy.handledToday} handled today
            </span>
          </div>
          {autopilotActions.length > 0 ? (
            <ul className="mt-3 grid gap-2">
              {autopilotActions.slice(0, 5).map((action) => (
                <li key={action.auditId} className="grid gap-1 border-t border-border pt-2 text-sm first:border-t-0 first:pt-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{action.title}</span>
                    <span className="shrink-0 text-xs uppercase text-muted-foreground">{action.action}</span>
                  </div>
                  {action.reason ? (
                    <div className="line-clamp-2 text-xs text-muted-foreground">{action.reason}</div>
                  ) : null}
                  {canUndo(action) && onUndoAutopilotAction ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-fit px-0"
                      onClick={() => onUndoAutopilotAction(action)}
                    >
                      Undo Autopilot action {action.title}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function autopilotModeLabel(mode: HubAutopilotPolicy["mode"]) {
  if (mode === "drive") return "Drive";
  if (mode === "assist") return "Assist";
  return "Off";
}
