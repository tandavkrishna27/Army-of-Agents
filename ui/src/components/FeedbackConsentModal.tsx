import { useState } from "react";
import type { FeedbackDataSharingPreference } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type FeedbackConsentDecision = Exclude<FeedbackDataSharingPreference, "prompt">;

interface FeedbackConsentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the user's durable decision ("allowed" / "not_allowed"). The
   * parent is responsible for persisting this to instance-settings, then
   * dismissing the modal. MVP has no "just this time" — Phase I polish.
   */
  onDecide: (decision: FeedbackConsentDecision) => Promise<void> | void;
  /** Disables all buttons while the parent persists the decision. */
  isSaving?: boolean;
}

export function FeedbackConsentModal({
  open,
  onOpenChange,
  onDecide,
  isSaving = false,
}: FeedbackConsentModalProps) {
  const [pending, setPending] = useState<FeedbackConsentDecision | null>(null);
  const busy = isSaving || pending !== null;

  async function handle(decision: FeedbackConsentDecision) {
    setPending(decision);
    try {
      await onDecide(decision);
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share feedback with AoA Labs?</DialogTitle>
          <DialogDescription>
            AoA runs locally and never shares data by default. To help improve
            agent quality, you can choose to send a redacted copy of votes to
            AoA Labs.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <p>
            When enabled, the voted comment plus nearby context is redacted and
            written to{" "}
            <code className="font-mono">~/.aoa/feedback-exports/</code>.
            Transmission to AoA Labs is pending a destination decision.
          </p>
          <p>You can change this anytime from Privacy settings.</p>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              aria-label="Never share feedback"
              onClick={() => handle("not_allowed")}
            >
              {pending === "not_allowed" ? "Saving…" : "Never"}
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={busy}
              aria-label="Always share feedback"
              onClick={() => handle("allowed")}
            >
              {pending === "allowed" ? "Saving…" : "Yes, always"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
