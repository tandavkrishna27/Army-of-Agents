import { Link } from "@/lib/router";
import type { HubItemListRow } from "@/api/hub-items";
import { Button } from "@/components/ui/button";
import { HubViewerScaffold } from "./HubViewerScaffold";

export function ReminderBody({ item }: { item: HubItemListRow }) {
  return (
    <HubViewerScaffold item={item}>
      {item.summary ? (
        <p className="text-sm leading-6 text-muted-foreground">{item.summary}</p>
      ) : null}
      <div className="mt-4">
        <Button asChild size="sm" variant="secondary">
          <Link to="/commander">Open in Commander</Link>
        </Button>
      </div>
    </HubViewerScaffold>
  );
}
