import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import type {
  FeedbackTargetType,
  FeedbackVote,
  FeedbackVoteValue,
} from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { feedbackApi } from "../api/feedback";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import {
  FeedbackConsentModal,
  type FeedbackConsentDecision,
} from "./FeedbackConsentModal";

interface FeedbackThumbsProps {
  /** Required per schema — every vote is task-contextualized. */
  issueId: string;
  targetType: FeedbackTargetType;
  targetId: string;
  /** Caller provides the existing vote (usually from a parent useQuery). */
  initialVote?: FeedbackVote | null;
  /** Fires after any successful mutation so callers can refetch. */
  onChange?: (vote: FeedbackVote | null) => void;
  className?: string;
}

export function FeedbackThumbs({
  issueId,
  targetType,
  targetId,
  initialVote = null,
  onChange,
  className,
}: FeedbackThumbsProps) {
  const queryClient = useQueryClient();
  const [vote, setVote] = useState<FeedbackVote | null>(initialVote);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [consentPending, setConsentPending] = useState<FeedbackVoteValue | null>(null);

  // F.4: preference controls whether a vote triggers a bundle build (server
  // side) and whether the consent modal is shown (client side). "prompt" means
  // "ask before the first vote, then remember". Fetched here so every thumbs
  // instance benefits from react-query's cache — settings are small and rarely
  // change during a session.
  const settingsQuery = useQuery({
    queryKey: queryKeys.instanceSettings.general,
    queryFn: () => instanceSettingsApi.getGeneral(),
    staleTime: 60_000,
  });
  const preference = settingsQuery.data?.feedbackDataSharingPreference;

  const recordMutation = useMutation({
    mutationFn: (args: { value: FeedbackVoteValue; reason?: string }) =>
      feedbackApi.recordVote(issueId, {
        targetType,
        targetId,
        vote: args.value,
        ...(args.reason ? { reason: args.reason } : {}),
      }),
    onSuccess: (saved) => {
      setVote(saved);
      onChange?.(saved);
    },
  });

  const dismissMutation = useMutation({
    mutationFn: (voteId: string) => feedbackApi.dismissVote(voteId),
    onSuccess: () => {
      setVote(null);
      setReasonOpen(false);
      setReason("");
      onChange?.(null);
    },
  });

  const preferenceMutation = useMutation({
    mutationFn: (next: FeedbackConsentDecision) =>
      instanceSettingsApi.updateGeneral({ feedbackDataSharingPreference: next }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.instanceSettings.general }),
  });

  const isUp = vote?.vote === "up";
  const isDown = vote?.vote === "down";
  const busy =
    recordMutation.isPending || dismissMutation.isPending || preferenceMutation.isPending;

  function submitVote(value: FeedbackVoteValue) {
    if (value === "down") {
      setReasonOpen(true);
      setReason(vote?.reason ?? "");
    } else {
      setReasonOpen(false);
      setReason("");
    }
    recordMutation.mutate({ value });
  }

  async function handleClick(value: FeedbackVoteValue) {
    // Toggle off when clicking the currently-selected thumb.
    if (vote && vote.vote === value) {
      dismissMutation.mutate(vote.id);
      return;
    }
    if (preference === "prompt") {
      // Stash the click; the modal resolves it after the user decides. If they
      // cancel, the vote is not recorded (per session spec).
      setConsentPending(value);
      return;
    }
    submitVote(value);
  }

  async function handleConsent(decision: FeedbackConsentDecision) {
    const pendingValue = consentPending;
    if (!pendingValue) return;
    // Persist the preference first so server-side gating (bundle build) sees
    // the new value by the time the vote route handler runs. Fire-and-forget
    // order would race; awaiting here is the right call even though the user
    // pays ~1 RTT.
    await preferenceMutation.mutateAsync(decision);
    setConsentPending(null);
    submitVote(pendingValue);
  }

  function handleConsentOpenChange(open: boolean) {
    if (!open) {
      // Dismiss = discard the click (no vote recorded).
      setConsentPending(null);
    }
  }

  function handleReasonSubmit() {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setReasonOpen(false);
      return;
    }
    recordMutation.mutate({ value: "down", reason: trimmed });
    setReasonOpen(false);
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>Was this helpful?</span>
        <Button
          type="button"
          size="icon-xs"
          variant={isUp ? "default" : "ghost"}
          aria-label="Thumbs up"
          aria-pressed={isUp}
          disabled={busy}
          onClick={() => handleClick("up")}
          className={cn(isUp && "ring-1 ring-primary/30")}
        >
          <ThumbsUp />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant={isDown ? "default" : "ghost"}
          aria-label="Thumbs down"
          aria-pressed={isDown}
          disabled={busy}
          onClick={() => handleClick("down")}
          className={cn(isDown && "ring-1 ring-primary/30")}
        >
          <ThumbsDown />
        </Button>
        {vote?.reason && !reasonOpen ? (
          <button
            type="button"
            className="ml-1 underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => {
              setReason(vote.reason ?? "");
              setReasonOpen(true);
            }}
          >
            Edit reason
          </button>
        ) : null}
      </div>

      <FeedbackConsentModal
        open={consentPending !== null}
        onOpenChange={handleConsentOpenChange}
        onDecide={handleConsent}
        isSaving={preferenceMutation.isPending}
      />

      {reasonOpen ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/20 p-2">
          <label
            htmlFor={`feedback-reason-${targetId}`}
            className="text-xs text-muted-foreground"
          >
            Why is this not helpful? (optional)
          </label>
          <Textarea
            id={`feedback-reason-${targetId}`}
            aria-label="Why is this not helpful?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What was missing or wrong?"
            className="min-h-16 text-sm"
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setReasonOpen(false);
                setReason("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              variant="default"
              disabled={busy}
              onClick={handleReasonSubmit}
              aria-label="Save feedback"
            >
              Save feedback
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
