import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type StackedIconTone = "teal" | "amber";

interface StackedIconProps {
  icon: LucideIcon;
  tone: StackedIconTone;
  /** Wrapper sizing class (Tailwind size-* or h-* / w-*). Defaults to size-12. */
  className?: string;
}

const TONE_CLASSES: Record<StackedIconTone, { back: string; mid: string; front: string; iconBack: string; iconMid: string; iconFront: string }> = {
  teal: {
    back: "bg-teal-500/10 border-teal-500/15",
    mid: "bg-teal-500/15 border-teal-500/25",
    front: "bg-teal-500/20 border-teal-500/40",
    iconBack: "text-teal-500/70",
    iconMid: "text-teal-500/85",
    iconFront: "text-teal-500",
  },
  amber: {
    back: "bg-amber-500/10 border-amber-500/15",
    mid: "bg-amber-500/15 border-amber-500/25",
    front: "bg-amber-500/20 border-amber-500/40",
    iconBack: "text-amber-500/70",
    iconMid: "text-amber-500/85",
    iconFront: "text-amber-500",
  },
};

/**
 * 3-layer receding icon stack. Used for marketplace cards that represent a
 * collection — `tone="teal"` for teams (multi-agent), `tone="amber"` for skill
 * packages (Phase C). Each layer is an absolutely-positioned rounded square
 * with reduced opacity on the back/mid layers and an offset transform.
 */
export function StackedIcon({ icon: Icon, tone, className }: StackedIconProps) {
  const t = TONE_CLASSES[tone];
  return (
    <div className={cn("relative size-12 shrink-0", className)}>
      <div
        data-stacked-layer="back"
        className={cn(
          "absolute inset-0 flex items-center justify-center rounded-[14px] border",
          t.back,
        )}
        style={{ transform: "translate(8px, -6px) scale(0.86)", opacity: 0.30 }}
      >
        <Icon className={cn("size-1/2", t.iconBack)} />
      </div>
      <div
        data-stacked-layer="mid"
        className={cn(
          "absolute inset-0 flex items-center justify-center rounded-[14px] border",
          t.mid,
        )}
        style={{ transform: "translate(4px, -3px) scale(0.93)", opacity: 0.55 }}
      >
        <Icon className={cn("size-1/2", t.iconMid)} />
      </div>
      <div
        data-stacked-layer="front"
        className={cn(
          "absolute inset-0 flex items-center justify-center rounded-[14px] border",
          t.front,
        )}
      >
        <Icon className={cn("size-1/2", t.iconFront)} />
      </div>
    </div>
  );
}
