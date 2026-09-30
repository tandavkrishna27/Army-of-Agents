import { Link } from "@/lib/router";
import type { HubItemListRow } from "@/api/hub-items";
import { Button } from "@/components/ui/button";
import { HubViewerScaffold } from "./HubViewerScaffold";

export function RoutineBody({ item }: { item: HubItemListRow }) {
  const routineId = item.relatedEntityId ?? item.sourceId ?? "";
  return (
    <HubViewerScaffold item={item}>
      {item.summary ? (
        <p className="text-sm leading-6 text-muted-foreground">{item.summary}</p>
      ) : (
        <p className="text-sm text-muted-foreground">No outcome details.</p>
      )}
      <div className="mt-4 flex gap-2">
        <Button asChild size="sm" variant="secondary">
          <Link to={routineId ? `/routines/${routineId}` : "/routines"}>Open routine</Link>
        </Button>
        <Button size="sm" variant="secondary" disabled title="Coming soon">
          Run now
        </Button>
      </div>
    </HubViewerScaffold>
  );
}
