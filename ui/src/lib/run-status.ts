import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Slash,
  Timer,
  type LucideIcon,
} from "lucide-react";

export interface RunStatusIcon {
  icon: LucideIcon;
  color: string;
}

/**
 * Canonical run-status -> icon/color map.
 *
 * `running` does NOT bake `animate-spin` into the color string; callers add
 * `animate-spin` at render time for running rows. This keeps the map
 * render-agnostic and unifies the previously-drifting copies in
 * AgentDetail.tsx and AoaRunsPanel.tsx.
 */
export const runStatusIcons: Record<string, RunStatusIcon> = {
  succeeded: { icon: CheckCircle2, color: "text-green-600 dark:text-green-400" },
  failed: { icon: XCircle, color: "text-red-600 dark:text-red-400" },
  running: { icon: Loader2, color: "text-cyan-600 dark:text-cyan-400" },
  queued: { icon: Clock, color: "text-yellow-600 dark:text-yellow-400" },
  timed_out: { icon: Timer, color: "text-orange-600 dark:text-orange-400" },
  cancelled: { icon: Slash, color: "text-neutral-500 dark:text-neutral-400" },
};

export function getRunStatusIcon(status: string): RunStatusIcon {
  return (
    runStatusIcons[status] ?? {
      icon: Clock,
      color: "text-neutral-500 dark:text-neutral-400",
    }
  );
}

export const runSourceLabels: Record<string, string> = {
  timer: "Timer",
  assignment: "Assignment",
  on_demand: "On-demand",
  automation: "Automation",
};

export const triggerTypeColors: Record<string, string> = {
  conversation: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  proactive: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  event: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  sub_agent: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
};

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "-";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}
