import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getAvatarInitials } from "./threadCardMeta";

export function AttentionCount({
  count,
  route = false,
}: {
  count: number;
  route?: boolean;
}) {
  return (
    <span
      className={cn(
        "thread-attention-pulse absolute right-2 top-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold shadow-[0_0_0_0_rgba(34,197,94,.35)]",
        route ? "bg-amber-300 text-amber-950" : "bg-emerald-500 text-white",
      )}
      aria-label={
        route
          ? `${count} item${count === 1 ? "" : "s"} needs routing`
          : `${count} item${count === 1 ? "" : "s"} need review`
      }
    >
      {count}
    </span>
  );
}

export function IconChip({
  Icon,
  label,
  tone = "default",
}: {
  Icon: LucideIcon;
  label: string;
  tone?: "default" | "source" | "scope" | "visibility" | "branch";
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-label={label}
            title={label}
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground",
              tone === "source" && "bg-card text-foreground",
              tone === "scope" && "text-blue-500 dark:text-blue-300",
              tone === "visibility" && "text-amber-500 dark:text-amber-300",
              tone === "branch" && "text-fuchsia-500 dark:text-fuchsia-300",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function LiveMarker() {
  return (
    <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full border border-teal-500/30 bg-teal-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal-600 dark:text-teal-300">
      <span className="h-1.5 w-1.5 rounded-full bg-teal-500" aria-hidden />
      Live
    </span>
  );
}

export function ParticipantStack({
  participants,
  total,
}: {
  participants: Array<{ name: string }>;
  total?: number;
}) {
  const visible = participants.slice(0, 3);
  const extra = Math.max((total ?? participants.length) - visible.length, 0);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center pl-1">
      {visible.map((participant, index) => (
        <Tooltip key={`${participant.name}-${index}`}>
          <TooltipTrigger asChild>
            <span
              title={participant.name}
              aria-label={participant.name}
              className="-ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border bg-muted px-1 text-[9px] font-semibold text-foreground shadow-[0_0_0_2px_hsl(var(--background))]"
            >
              {getAvatarInitials(participant.name)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {participant.name}
          </TooltipContent>
        </Tooltip>
      ))}
      {extra > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              title={`${extra} more participant${extra === 1 ? "" : "s"}`}
              aria-label={`${extra} more participant${extra === 1 ? "" : "s"}`}
              className="-ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border bg-muted px-1 text-[9px] font-semibold text-muted-foreground shadow-[0_0_0_2px_hsl(var(--background))]"
            >
              +{extra}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {extra} more participant{extra === 1 ? "" : "s"}
          </TooltipContent>
        </Tooltip>
      )}
      </div>
    </TooltipProvider>
  );
}
