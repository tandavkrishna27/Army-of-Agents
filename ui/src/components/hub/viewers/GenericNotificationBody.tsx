import { Link } from "@/lib/router";
import type { HubItemListRow } from "@/api/hub-items";
import { Button } from "@/components/ui/button";
import { HUB_REGISTRY } from "../hubRegistry";
import { HubViewerScaffold } from "./HubViewerScaffold";

export function GenericNotificationBody({ item }: { item: HubItemListRow }) {
  const fullLink = HUB_REGISTRY[item.semanticType]?.fullLink(item) ?? null;
  return (
    <HubViewerScaffold item={item}>
      {item.summary ? (
        <p className="text-sm leading-6 text-muted-foreground">{item.summary}</p>
      ) : (
        <p className="text-sm text-muted-foreground">No further details.</p>
      )}
      {fullLink ? (
        <div className="mt-4">
          <Button asChild size="sm" variant="secondary">
            <Link to={fullLink}>Open</Link>
          </Button>
        </div>
      ) : null}
    </HubViewerScaffold>
  );
}
