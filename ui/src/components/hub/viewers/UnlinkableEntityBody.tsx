import type { HubItemListRow } from "@/api/hub-items";
import { HubViewerScaffold } from "./HubViewerScaffold";

export function UnlinkableEntityBody({
  item,
  kind,
}: {
  item: HubItemListRow;
  kind: "artifact" | "memory";
}) {
  return (
    <HubViewerScaffold item={item}>
      <p className="text-sm leading-6 text-muted-foreground">
        This {kind} is not directly linkable from the hub yet. Open the related
        entity from its source surface to review it.
      </p>
    </HubViewerScaffold>
  );
}
