import {
  FileText,
  Home,
  Image as ImageIcon,
  LayoutGrid,
  ListTree,
  Network,
  type LucideIcon,
} from "lucide-react";
import { ViewerTabs, type ViewerTabModel } from "@/components/viewers/ViewerTabs";
import type { MemoryTab, MemoryTabKind, TabKey } from "../../lib/memoryTabs";

interface Props {
  tabs: ReadonlyArray<MemoryTab>;
  activeKey: TabKey | null;
  onActivate: (id: string, kind: MemoryTabKind) => void;
  onClose: (id: string, kind: MemoryTabKind) => void;
  onAdd?: () => void;
  onToggleCollapse?: () => void;
}

const ICON_FOR_KIND: Record<MemoryTabKind, LucideIcon> = {
  home: Home,
  memory_item: FileText,
  asset: ImageIcon,
  graph: Network,
  open: LayoutGrid,
  collection: ListTree,
};

export function MemoryViewerTabs({
  tabs,
  activeKey,
  onActivate,
  onClose,
  onAdd,
  onToggleCollapse,
}: Props) {
  const viewerTabs: ViewerTabModel[] = tabs.map((tab) => ({
    ...tab,
    icon: ICON_FOR_KIND[tab.kind],
  }));

  return (
    <ViewerTabs
      tabs={viewerTabs}
      activeKey={activeKey}
      onActivate={(tab) => onActivate(tab.id, tab.kind as MemoryTabKind)}
      onClose={(tab) => onClose(tab.id, tab.kind as MemoryTabKind)}
      onAdd={onAdd}
      addLabel="New memory viewer tab"
      onToggleCollapse={onToggleCollapse}
      tabListLabel="Open memory items"
      headerTestId="memory-viewer-header"
    />
  );
}
