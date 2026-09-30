import { Link } from "@/lib/router";
import type { HubItemListRow } from "@/api/hub-items";
import { Button } from "@/components/ui/button";
import { HubViewerScaffold } from "./HubViewerScaffold";

export function SuggestionBody({ item }: { item: HubItemListRow }) {
  return (
    <HubViewerScaffold item={item}>
      {item.summary ? (
        <p className="text-sm leading-6 text-muted-foreground">{item.summary}</p>
      ) : (
        <p className="text-sm text-muted-foreground">No rationale provided.</p>
      )}
      <div className="mt-4 flex gap-2">
        <Button size="sm" disabled title="Coming soon">
          Apply
        </Button>
        <Button asChild size="sm" variant="secondary">
          <Link to="/home">Open</Link>
        </Button>
      </div>
    </HubViewerScaffold>
  );
}
