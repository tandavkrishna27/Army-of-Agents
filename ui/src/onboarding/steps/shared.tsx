import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared dark-spine styling primitives (WS3). Every spine step (Profile →
 * Company → Environment → Commander → Verify → SpineComplete) renders inside
 * FlowEngine's `.onboarding-dark` + `<ConstellationBg/>` shell (see
 * FlowEngine.tsx) — these helpers assume that ancestor scope for their CSS
 * custom properties (`--brand-hover`, `--amber`, `--card`, `--field`, …;
 * `--amber` in particular is ONLY defined under `.onboarding-dark`, see
 * motion/motion.css) and must not be used outside it.
 */

/** The mockup's headline gradient (screens S2–S5): coral → brand → amber. */
export function GradientText({ children }: { children: ReactNode }) {
  return (
    <span
      className="bg-clip-text text-transparent"
      style={{ backgroundImage: "linear-gradient(135deg, #f1a193, var(--brand-hover), var(--amber))" }}
    >
      {children}
    </span>
  );
}

/** Shared text-field styling for the dark spine steps (mockup `.field`). */
export const FIELD =
  "w-full rounded-md border border-border-strong bg-field px-3 py-2.5 text-sm text-text outline-none placeholder:text-very-dim focus:border-brand focus:ring-1 focus:ring-brand";

export const LABEL = "mb-1 block text-left text-xs text-dim";

/** The mockup's `.card-el` — the dark card wrapping a step's form fields. */
export function StepCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("w-full rounded-xl border border-border bg-card p-[18px] text-left", className)}>
      {children}
    </div>
  );
}

/** Centered heading + subtitle block shared by every spine step. */
export function StepHeading({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <h1 className="text-2xl font-bold tracking-tight text-text sm:text-[28px]">{title}</h1>
      {subtitle && <p className="max-w-sm text-sm text-dim">{subtitle}</p>}
    </div>
  );
}

/**
 * Outer shell every spine step renders into — centers content, caps width.
 * `items-stretch` (not `items-center`) so a `w-full` child (StepCard, the
 * Continue button) fills the shell even through an intervening `<Reveal>`
 * wrapper div, which has no width class of its own.
 */
export function StepShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto flex w-full max-w-md flex-col items-stretch gap-4 py-6", className)}>
      {children}
    </div>
  );
}
