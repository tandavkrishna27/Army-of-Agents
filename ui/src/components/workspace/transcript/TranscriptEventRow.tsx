// ui/src/components/workspace/transcript/TranscriptEventRow.tsx

import { cn } from "@/lib/utils";
import { Info, AlertTriangle, XCircle, Minus } from "lucide-react";

interface TranscriptEventRowProps {
  label: string;
  text: string;
  tone: "info" | "warn" | "error" | "neutral";
  className?: string;
}

const TONE_STYLES = {
  info: { icon: Info, color: "text-blue-500" },
  warn: { icon: AlertTriangle, color: "text-amber-500" },
  error: { icon: XCircle, color: "text-red-500" },
  neutral: { icon: Minus, color: "text-muted-foreground" },
};

export function TranscriptEventRow({ label, text, tone, className }: TranscriptEventRowProps) {
  const { icon: Icon, color } = TONE_STYLES[tone];
  return (
    <div className={cn("flex items-center gap-2 px-3 h-8 text-xs text-muted-foreground", className)}>
      <Icon className={cn("h-3.5 w-3.5 shrink-0", color)} />
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground/60">·</span>
      <span className="truncate">{text}</span>
    </div>
  );
}
