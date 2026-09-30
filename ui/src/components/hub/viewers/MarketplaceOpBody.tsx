import { Link } from "@/lib/router";
import type { HubItemListRow } from "@/api/hub-items";
import { Button } from "@/components/ui/button";
import { HubViewerScaffold } from "./HubViewerScaffold";

export function MarketplaceOpBody({ item }: { item: HubItemListRow }) {
  return (
    <HubViewerScaffold item={item}>
      {item.summary ? (
        <p className="text-sm leading-6 text-muted-foreground">{item.summary}</p>
      ) : (
        <p className="text-sm text-muted-foreground">Operation status unavailable.</p>
      )}
      <div className="mt-4">
        <Button asChild size="sm" variant="secondary">
          <Link to="/marketplace">View</Link>
        </Button>
      </div>
    </HubViewerScaffold>
  );
}
