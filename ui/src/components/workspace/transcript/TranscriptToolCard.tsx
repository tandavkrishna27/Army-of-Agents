// ui/src/components/workspace/transcript/TranscriptToolCard.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Image,
  Video,
  FileText,
  BarChart3,
  Music,
  Paintbrush,
  Mail,
  ChevronRight,
  ChevronDown,
  Check,
  X,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import type { EntryCategory } from "./types";

const CARD_CONFIG: Partial<Record<EntryCategory, { icon: LucideIcon; label: string }>> = {
  image_generated: { icon: Image, label: "Image generated" },
  video_generated: { icon: Video, label: "Video generated" },
  audio_generated: { icon: Music, label: "Audio generated" },
  content_generated: { icon: FileText, label: "Content generated" },
  report_generated: { icon: BarChart3, label: "Report generated" },
  chart_generated: { icon: BarChart3, label: "Chart generated" },
  draft_response: { icon: Mail, label: "Draft response" },
  design_asset: { icon: Paintbrush, label: "Design asset" },
  animation_created: { icon: Paintbrush, label: "Animation created" },
  email_campaign: { icon: Mail, label: "Email draft" },
};

interface TranscriptToolCardProps {
  name: string;
  summary: string;
  category: EntryCategory;
  status: "running" | "completed" | "error";
  result?: string;
  input?: unknown;
  className?: string;
}

export function TranscriptToolCard({
  name,
  summary,
  category,
  status,
  result,
  input,
  className,
}: TranscriptToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const config = CARD_CONFIG[category] ?? { icon: FileText, label: name };
  const Icon = config.icon;

  // Truncate preview to 4 lines
  const preview = result ? result.split("\n").slice(0, 4).join("\n") : null;
  const hasMore = result ? result.split("\n").length > 4 : false;

  return (
    <div className={cn("rounded-xl border border-border bg-card shadow-sm overflow-hidden", className)}>
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 h-10 text-left hover:bg-muted/30 transition-colors"
      >
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-[13px] text-foreground/80 flex-1 truncate">
          {config.label} · {summary}
        </span>
        {status === "running" && <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />}
        {status === "completed" && <Check className="h-3.5 w-3.5 text-emerald-500" />}
        {status === "error" && <X className="h-3.5 w-3.5 text-red-500" />}
        {result && (expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />)}
      </button>

      {/* Preview (always shown for completed cards with results) */}
      {status === "completed" && preview && !expanded && (
        <div className="px-3 pb-3 text-xs text-muted-foreground whitespace-pre-wrap">
          {preview}
          {hasMore && <span className="text-primary cursor-pointer" onClick={() => setExpanded(true)}> Show more</span>}
        </div>
      )}

      {/* Full result (expanded) */}
      {expanded && result && (
        <div className="px-3 pb-3 text-xs text-foreground/70 whitespace-pre-wrap max-h-[300px] overflow-auto">
          {result}
        </div>
      )}
    </div>
  );
}
