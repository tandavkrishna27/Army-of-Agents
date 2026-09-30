// ui/src/components/workspace/transcript/TranscriptEditGroup.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import { FileEdit, ChevronRight, ChevronDown } from "lucide-react";
import type { AggregatedGroup } from "./types";
import { parseEditStats, extractFilePath } from "./aggregate-blocks";

interface TranscriptEditGroupProps {
  group: Extract<AggregatedGroup, { type: "edit_group" | "multi_edit_group" }>;
  className?: string;
}

export function TranscriptEditGroup({ group, className }: TranscriptEditGroupProps) {
  const [expanded, setExpanded] = useState(false);

  const label = group.type === "edit_group"
    ? `Edited ${group.filePath.split("/").pop() ?? group.filePath}`
    : `Edited ${group.fileCount} files`;

  const totalStats = group.type === "edit_group"
    ? { additions: group.totalAdditions, deletions: group.totalDeletions }
    : group.items.reduce(
        (acc, item) => {
          const s = parseEditStats(item.result);
          return { additions: acc.additions + s.additions, deletions: acc.deletions + s.deletions };
        },
        { additions: 0, deletions: 0 },
      );

  return (
    <div className={cn("", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex h-9 w-full items-center gap-2 rounded-md bg-transparent px-1 text-left text-muted-foreground transition-colors hover:bg-card/50 hover:text-foreground"
      >
        <FileEdit className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-mono">
          {label}
        </span>
        {(totalStats.additions > 0 || totalStats.deletions > 0) && (
          <span className="shrink-0 text-xs">
            {totalStats.additions > 0 && <span className="text-emerald-500">{`+${totalStats.additions}`}</span>}
            {totalStats.additions > 0 && totalStats.deletions > 0 && " "}
            {totalStats.deletions > 0 && <span className="text-red-400">{`-${totalStats.deletions}`}</span>}
          </span>
        )}
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </button>
      {expanded && (
        <div className="ml-5 mt-1 space-y-0.5 border-l border-border pl-3">
          {group.items.map((item, i) => {
            const stats = parseEditStats(item.result);
            const filePath = extractFilePath(item.input);
            return (
              <div key={i} className="grid h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs text-muted-foreground">
                <span className="truncate font-mono">{filePath ?? `Edit ${i + 1}`}</span>
                {(stats.additions > 0 || stats.deletions > 0) && (
                  <span className="shrink-0">
                    {stats.additions > 0 && <span className="text-emerald-500">{`+${stats.additions}`}</span>}
                    {stats.additions > 0 && stats.deletions > 0 && " "}
                    {stats.deletions > 0 && <span className="text-red-400">{`-${stats.deletions}`}</span>}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
