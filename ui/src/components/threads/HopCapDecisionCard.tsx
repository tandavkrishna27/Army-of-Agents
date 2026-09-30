import { AlertCircle } from "lucide-react";

interface HopCapDecisionCardProps {
  hopCount: number;
  cap: number;
}

export function HopCapDecisionCard({ hopCount, cap }: HopCapDecisionCardProps) {
  return (
    <div
      className="rounded-lg border border-amber-500/30 bg-card/40 p-4 flex flex-col gap-3"
      data-testid="hop-cap-decision-card"
    >
      <div className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-semibold text-foreground">Agent loop paused</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {hopCount} / {cap} hops
        </span>
      </div>
      <p className="text-sm text-foreground/80">
        The crew has reached the hop cap without a human checkpoint. Scope the work to create
        deliverables, or reply to let the crew continue.
      </p>
      <p className="text-xs text-muted-foreground">
        Reply in the thread to reset the hop counter and continue the conversation.
      </p>
    </div>
  );
}
