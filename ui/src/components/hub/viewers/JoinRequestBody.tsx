import { Link } from "@/lib/router";
import type { HubItemListRow } from "@/api/hub-items";
import { Button } from "@/components/ui/button";
import { HubViewerScaffold } from "./HubViewerScaffold";

export function JoinRequestBody({ item }: { item: HubItemListRow }) {
  const target = "/team?tab=requests";
  return (
    <HubViewerScaffold item={item}>
      {item.summary ? (
        <p className="text-sm leading-6 text-muted-foreground">{item.summary}</p>
      ) : null}
      <div className="mt-4 flex gap-2">
        <Button asChild size="sm">
          <Link to={target}>Approve</Link>
        </Button>
        <Button asChild size="sm" variant="secondary">
          <Link to={target}>Decline</Link>
        </Button>
      </div>
    </HubViewerScaffold>
  );
}
