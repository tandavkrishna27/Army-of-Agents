import type { ReactNode } from "react";
import type { HubItemListRow } from "@/api/hub-items";
import { HUB_REGISTRY } from "../hubRegistry";

export function HubViewerScaffold({
  item,
  children,
}: {
  item: HubItemListRow;
  children: ReactNode;
}) {
  const label = HUB_REGISTRY[item.semanticType]?.label ?? "Item";
  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-y-auto p-5" data-testid="hub-viewer-scaffold">
      <h2 className="text-lg font-semibold leading-snug text-text">{item.title}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <Chip>{item.priority}</Chip>
        <Chip>{item.sourceType ?? label}</Chip>
        <Chip>{formatWhen(item.createdAt)}</Chip>
      </div>
      <div className="mt-4 min-h-0 flex-1">{children}</div>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex rounded border border-border px-1.5 py-0.5">{children}</span>
  );
}

function formatWhen(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
