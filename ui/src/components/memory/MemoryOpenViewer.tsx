import {
  ClipboardCheck,
  Clock,
  Network,
  Unlink,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MEMORY_BRAIN_TAB,
  MEMORY_RECENT_TAB,
  MEMORY_REVIEW_QUEUE_TAB,
  MEMORY_UNLINKED_TAB,
  type MemoryTab,
} from "../../lib/memoryTabs";

interface MemoryOpenViewerProps {
  onOpenTab?: (tab: MemoryTab) => void;
}

const OPEN_OPTIONS: Array<{
  tab: MemoryTab;
  icon: LucideIcon;
  description: string;
}> = [
  {
    tab: MEMORY_BRAIN_TAB,
    icon: Network,
    description: "Company knowledge map",
  },
  {
    tab: MEMORY_RECENT_TAB,
    icon: Clock,
    description: "Recently used memory",
  },
  {
    tab: MEMORY_UNLINKED_TAB,
    icon: Unlink,
    description: "Items without graph links",
  },
  {
    tab: MEMORY_REVIEW_QUEUE_TAB,
    icon: ClipboardCheck,
    description: "Memories needing review",
  },
];

export function MemoryOpenViewer({ onOpenTab }: MemoryOpenViewerProps) {
  return (
    <div className="h-full min-h-0 overflow-auto p-4" data-testid="memory-open-viewer">
      <div className="mb-3">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Open
        </div>
        <h2 className="mt-1 text-sm font-semibold">Memory viewer</h2>
      </div>
      <div className="grid gap-2">
        {OPEN_OPTIONS.map(({ tab, icon: Icon, description }) => (
          <Button
            key={`${tab.kind}:${tab.id}`}
            type="button"
            variant="outline"
            className="h-auto justify-start gap-3 px-3 py-3 text-left"
            aria-label={`Open ${tab.title}`}
            onClick={() => onOpenTab?.(tab)}
          >
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{tab.title}</span>
              <span className="block truncate text-xs font-normal text-muted-foreground">
                {description}
              </span>
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
