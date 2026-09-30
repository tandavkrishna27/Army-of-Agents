import * as React from "react";
import { cn } from "@/lib/utils";

export type Step = {
  id: string;
  label: string;
  description?: string;
};

export type StepperVariant = "horizontal" | "vertical" | "dots";

export interface StepperProps {
  steps: Step[];
  current: number;
  onStepClick?: (index: number) => void;
  variant?: StepperVariant;
  className?: string;
}

function getState(index: number, current: number): "done" | "active" | "pending" {
  if (index < current) return "done";
  if (index === current) return "active";
  return "pending";
}

function DotsStepper({ steps, current, onStepClick, className }: StepperProps) {
  return (
    <div className={cn("flex items-center gap-1.5", className)} role="navigation" aria-label="Progress">
      {steps.map((s, i) => {
        const state = getState(i, current);
        const clickable = onStepClick && state !== "pending";
        return (
          <button
            key={s.id}
            type="button"
            disabled={!clickable}
            onClick={() => clickable && onStepClick!(i)}
            aria-label={`Step ${i + 1}: ${s.label}`}
            aria-current={state === "active" ? "step" : undefined}
            data-state={state}
            className={cn(
              "size-2 rounded-full transition-all",
              state === "active" && "w-[22px] bg-brand shadow-[0_0_0_3px_var(--brand-focus-ring)]",
              state === "done" && "bg-brand opacity-60",
              state === "pending" && "bg-[hsl(0_0%_25%)]",
              clickable && "cursor-pointer",
              !clickable && "cursor-default"
            )}
          />
        );
      })}
    </div>
  );
}

function VerticalStepper({ steps, current, onStepClick, className }: StepperProps) {
  return (
    <div className={cn("flex flex-col", className)} role="navigation" aria-label="Progress">
      {steps.map((s, i) => {
        const state = getState(i, current);
        const clickable = onStepClick && state !== "pending";
        const isLast = i === steps.length - 1;
        return (
          <button
            key={s.id}
            type="button"
            disabled={!clickable}
            onClick={() => clickable && onStepClick!(i)}
            aria-current={state === "active" ? "step" : undefined}
            data-state={state}
            className={cn(
              "flex gap-3 py-2 rounded-md text-left",
              clickable && "cursor-pointer hover:bg-white/[0.02]",
              !clickable && "cursor-default"
            )}
          >
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "size-[22px] rounded-full font-mono text-[0.7rem] font-semibold inline-flex items-center justify-center shrink-0 z-10",
                  state === "active" && "bg-brand text-white shadow-[0_0_0_4px_var(--brand-focus-ring)]",
                  state === "done" && "bg-brand text-white opacity-70",
                  state === "pending" && "bg-[hsl(0_0%_25%)] text-[hsl(0_0%_75%)]"
                )}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              {!isLast && (
                <div className={cn("flex-1 w-px mt-0.5 min-h-[18px]", state === "done" ? "bg-brand/40" : "bg-[hsl(0_0%_18%)]")} />
              )}
            </div>
            <div className="pt-px pb-3">
              <div className={cn("text-sm", state === "active" ? "text-text font-semibold" : "text-dim font-medium")}>{s.label}</div>
              {s.description && <div className="text-xs text-very-dim mt-0.5">{s.description}</div>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function HorizontalStepper({ steps, current, onStepClick, className }: StepperProps) {
  return (
    <div className={cn("flex items-center gap-1.5", className)} role="navigation" aria-label="Progress">
      {steps.map((s, i) => {
        const state = getState(i, current);
        const clickable = onStepClick && state !== "pending";
        const isLast = i === steps.length - 1;
        return (
          <React.Fragment key={s.id}>
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onStepClick!(i)}
              aria-current={state === "active" ? "step" : undefined}
              data-state={state}
              className={cn(
                "flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-md transition-colors",
                state === "pending" && "text-dim cursor-default",
                state === "active" && "text-text",
                state === "done" && "text-dim",
                clickable && "cursor-pointer hover:bg-white/[0.04] hover:text-text"
              )}
            >
              <span
                className={cn(
                  "size-[18px] rounded-full font-mono text-[0.66rem] font-semibold inline-flex items-center justify-center shrink-0",
                  state === "active" && "bg-brand text-white shadow-[0_0_0_3px_var(--brand-focus-ring)]",
                  state === "done" && "bg-brand text-white opacity-70",
                  state === "pending" && "bg-[hsl(0_0%_25%)] text-[hsl(0_0%_75%)]"
                )}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              {s.label}
            </button>
            {!isLast && <div className={cn("flex-1 h-px", state === "done" ? "bg-brand/50" : "bg-[hsl(0_0%_18%)]")} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function Stepper(props: StepperProps) {
  const { variant = "horizontal" } = props;
  if (variant === "dots") return <DotsStepper {...props} />;
  if (variant === "vertical") return <VerticalStepper {...props} />;
  return <HorizontalStepper {...props} />;
}
