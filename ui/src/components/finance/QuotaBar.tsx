import { cn } from "@/lib/utils";

export interface QuotaBarProps {
  label: string;
  used: number;
  limit: number;
  valueLabel?: string;
  className?: string;
}

type Tone = "healthy" | "warn" | "hard";

function toneFor(percent: number): Tone {
  if (percent >= 90) return "hard";
  if (percent >= 70) return "warn";
  return "healthy";
}

function fillColor(tone: Tone): string {
  if (tone === "hard") return "bg-red-500";
  if (tone === "warn") return "bg-amber-500";
  return "bg-green-500";
}

export function QuotaBar({
  label,
  used,
  limit,
  valueLabel,
  className,
}: QuotaBarProps) {
  const rawPercent = limit > 0 ? (used / limit) * 100 : 0;
  const roundedPercent = Math.round(rawPercent);
  const clampedPercent = Math.min(100, Math.max(0, rawPercent));
  const tone = toneFor(rawPercent);
  const displayValue = valueLabel ?? `${used} / ${limit}`;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className="flex items-center gap-2 shrink-0 text-xs tabular-nums">
          <span className="font-medium">{displayValue}</span>
          <span className="text-muted-foreground">{roundedPercent}%</span>
        </div>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          data-testid="quota-bar-fill"
          data-tone={tone}
          className={cn(
            "h-full rounded-full transition-[width,background-color] duration-200",
            fillColor(tone),
          )}
          style={{ width: `${clampedPercent}%` }}
        />
      </div>
    </div>
  );
}
