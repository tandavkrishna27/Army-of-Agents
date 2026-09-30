import { cn } from "@/lib/utils";

export type Tone = "indigo" | "teal" | "amber" | "magenta" | "green" | "slate";

const TONE_VAR: Record<Tone, string> = {
  indigo: "var(--data-indigo)",
  teal: "var(--data-teal)",
  amber: "var(--data-amber)",
  magenta: "var(--data-magenta)",
  green: "var(--data-green)",
  slate: "var(--data-slate)",
};

export interface MemoryChipProps {
  label: string;
  tone?: Tone;
  className?: string;
}

export function MemoryChip({ label, tone, className }: MemoryChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5",
        "border border-border bg-white/[0.04]",
        "text-[10px] leading-[14px] font-medium text-muted-foreground whitespace-nowrap",
        className,
      )}
    >
      {tone && (
        <span
          aria-hidden="true"
          data-slot="dot"
          className="size-1.5 rounded-full"
          style={{ background: TONE_VAR[tone] }}
        />
      )}
      <span>{label}</span>
    </span>
  );
}
