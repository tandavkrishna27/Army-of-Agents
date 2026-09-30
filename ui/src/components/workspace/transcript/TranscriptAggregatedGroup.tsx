// ui/src/components/workspace/transcript/TranscriptAggregatedGroup.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import { FileText, Search, Globe, Terminal, Wrench, ChevronRight, ChevronDown, type LucideIcon } from "lucide-react";
import type { AggregatedGroup, DepartmentType } from "./types";
import { TranscriptToolPill } from "./TranscriptToolPill";
import { classifyToolEntry } from "./classify-entry";
import { summarizeToolInput, displayToolName } from "./normalize-transcript";

const GROUP_CONFIG: Record<string, { icon: LucideIcon; label: (n: number) => string }> = {
  read_group: { icon: FileText, label: (n) => `Read ${n} file${n !== 1 ? "s" : ""}` },
  search_group: { icon: Search, label: (n) => `Searched ${n} time${n !== 1 ? "s" : ""}` },
  web_group: { icon: Globe, label: (n) => `Opened ${n} web request${n !== 1 ? "s" : ""}` },
  command_group_agg: { icon: Terminal, label: (n) => `Ran ${n} command${n !== 1 ? "s" : ""}` },
  generic_group: { icon: Wrench, label: (n) => `Used ${n} tool${n !== 1 ? "s" : ""}` },
};

interface TranscriptAggregatedGroupProps {
  group: Extract<AggregatedGroup, { type: "read_group" | "search_group" | "web_group" | "command_group_agg" | "generic_group" }>;
  departmentType: DepartmentType;
  className?: string;
}

export function TranscriptAggregatedGroup({ group, departmentType, className }: TranscriptAggregatedGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const config = GROUP_CONFIG[group.type] ?? GROUP_CONFIG.generic_group!;
  const Icon = config.icon;

  return (
    <div className={cn("", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex h-8 w-full items-center gap-2 rounded-md bg-transparent px-1 text-left text-muted-foreground transition-colors hover:bg-card/50 hover:text-foreground"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px]">{config.label(group.count)}</span>
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </button>
      {expanded && (
        <div className="ml-5 mt-1 space-y-0.5 border-l border-border pl-3">
          {group.items.map((item, i) => {
            const category = classifyToolEntry(item.name, item.input, departmentType);
            const summary = summarizeToolInput(item.name, item.input);
            return (
              <TranscriptToolPill
                key={i}
                name={displayToolName(item.name, item.input)}
                summary={summary}
                category={category}
                status={item.status}
                result={item.result}
                input={item.input}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
