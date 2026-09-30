import { cn } from "@/lib/utils";

/** The mockup's stepper (screens S2–S5): a row of pips, done/current/upcoming. */
export function StepperPips({ total, current }: { total: number; current: number }) {
  if (total <= 1) return null;
  return (
    <div className="flex items-center gap-1.5" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => {
        const n = i + 1;
        return (
          <span
            key={n}
            className={cn(
              "h-1 w-[22px] rounded-full bg-border-strong transition-colors",
              n < current && "bg-brand",
              n === current && "bg-brand-hover shadow-[0_0_8px_rgba(209,58,38,0.6)]",
            )}
          />
        );
      })}
    </div>
  );
}

/**
 * Shared "Step N of M" chrome — the pips + a mono position readout. Rendered by
 * `FlowEngine` (spine) AND the post-spine Home first-run surfaces (the Map + the
 * In-flight tail) so the counter runs continuously across the whole onboarding.
 * Renders nothing when `total <= 1` (single-step journeys carry no info).
 */
export function StepPosition({ current, total }: { current: number; total: number }) {
  if (total <= 1) return null;
  return (
    <div className="flex items-center gap-3">
      <StepperPips total={total} current={current} />
      <span
        data-testid="onboarding-step-position"
        className="font-mono text-[10.5px] tracking-[0.14em] text-very-dim"
      >
        Step {current} of {total}
      </span>
    </div>
  );
}
