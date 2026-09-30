// ui/src/components/workspace/transcript/TranscriptToolPill.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  FileText,
  Search,
  Terminal,
  Globe,
  Wrench,
  ChevronRight,
  ChevronDown,
  Check,
  X,
  Loader2,
  GitBranch,
  FlaskConical,
  Hammer,
  Upload,
  Download,
  Brain,
  ShieldCheck,
  Ticket,
  BookOpen,
  FileEdit,
  BarChart3,
  Scale,
  Users,
  Calendar,
  Microscope,
  Cog,
  Bell,
  type LucideIcon,
} from "lucide-react";
import type { EntryCategory, EditStats } from "./types";

const CATEGORY_ICONS: Partial<Record<EntryCategory, LucideIcon>> = {
  file_read: FileText,
  file_edit: FileEdit,
  search: Search,
  command: Terminal,
  web: Globe,
  api_call: Globe,
  file_upload: Upload,
  file_download: Download,
  memory_operation: Brain,
  approval_requested: ShieldCheck,
  generic_tool: Wrench,
  // Software dev
  git_operation: GitBranch,
  test_run: FlaskConical,
  build: Hammer,
  // Support
  ticket_lookup: Ticket,
  knowledge_search: BookOpen,
  // Finance
  calculation: BarChart3,
  report_generated: BarChart3,
  compliance_check: ShieldCheck,
  // Legal
  clause_reviewed: Scale,
  regulatory_check: Scale,
  // HR
  candidate_lookup: Users,
  schedule_action: Calendar,
  // Research
  literature_search: Microscope,
  // Operations
  workflow_triggered: Cog,
  notification_sent: Bell,
};

interface TranscriptToolPillProps {
  name: string;
  summary: string;
  category: EntryCategory;
  status: "running" | "completed" | "error";
  editStats?: EditStats;
  result?: string;
  input?: unknown;
  className?: string;
}

export function TranscriptToolPill({
  name,
  summary,
  category,
  status,
  editStats,
  result,
  input,
  className,
}: TranscriptToolPillProps) {
  const [expanded, setExpanded] = useState(false);
  const Icon = CATEGORY_ICONS[category] ?? Wrench;
  const hasExpandable = Boolean(result || input);

  return (
    <div className={cn("group", className)}>
      <button
        type="button"
        onClick={() => hasExpandable && setExpanded(!expanded)}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md bg-transparent px-1 text-left text-muted-foreground transition-colors hover:bg-card/50 hover:text-foreground",
          status === "error" && "text-destructive",
          hasExpandable && "cursor-pointer",
          !hasExpandable && "cursor-default",
        )}
        disabled={!hasExpandable}
        aria-label={`${name} ${summary}, ${status}`}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px]">
          {category === "file_read" || category === "file_edit" || category === "search" || category === "command"
            ? <span className="font-mono">{summary}</span>
            : summary}
        </span>
        {editStats && (editStats.additions > 0 || editStats.deletions > 0) && (
          <span className="shrink-0 text-xs">
            {editStats.additions > 0 && <span className="text-emerald-500">{`+${editStats.additions}`}</span>}
            {editStats.additions > 0 && editStats.deletions > 0 && " "}
            {editStats.deletions > 0 && <span className="text-red-400">{`-${editStats.deletions}`}</span>}
          </span>
        )}
        {status === "running" && <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />}
        {status === "completed" && <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />}
        {status === "error" && <X className="h-3.5 w-3.5 text-red-500 shrink-0" />}
        {hasExpandable && (
          expanded
            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
        )}
      </button>
      {expanded && hasExpandable && (
        <div className="mb-2 ml-5 mt-1 max-h-[300px] overflow-auto whitespace-pre-wrap border-l border-border py-1 pl-3 text-xs font-mono text-muted-foreground">
          {result ?? (typeof input === "string" ? input : (input != null ? JSON.stringify(input, null, 2) : ""))}
        </div>
      )}
    </div>
  );
}
