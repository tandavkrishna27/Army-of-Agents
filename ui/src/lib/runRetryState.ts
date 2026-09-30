export type RunRetryTone = "warning" | "danger" | "muted";

export interface RetryRunLike {
  status: string;
  scheduledRetryReason?: string | null;
  scheduledRetryAttempt?: number | null;
  scheduledRetryAt?: Date | string | null;
  errorCode?: string | null;
}

export interface RunRetryState {
  label: string;
  detail?: string;
  tone: RunRetryTone;
}

function isMaxTurnContinuation(run: RetryRunLike): boolean {
  return run.scheduledRetryReason === "max_turn_continuation";
}

function isStaleRetryCancellation(run: RetryRunLike): boolean {
  return run.status === "cancelled" && typeof run.errorCode === "string" && run.errorCode.includes("stale");
}

function isMaxTurnExhausted(run: RetryRunLike): boolean {
  return (
    isMaxTurnContinuation(run) &&
    (run.errorCode === "max_turn_continuation_exhausted" || run.errorCode === "max_turn_continuation_retry_exhausted")
  );
}

export function getRunRetryState(run: RetryRunLike): RunRetryState | null {
  if (isStaleRetryCancellation(run)) {
    return { label: "Stale retry cancelled", tone: "muted" };
  }

  if (isMaxTurnExhausted(run)) {
    return { label: "Max-turn continuation exhausted", tone: "danger" };
  }

  if (run.status !== "scheduled_retry") {
    return null;
  }

  const attempt = Number.isFinite(run.scheduledRetryAttempt) && (run.scheduledRetryAttempt ?? 0) > 0
    ? `Attempt ${run.scheduledRetryAttempt}`
    : undefined;

  if (isMaxTurnContinuation(run)) {
    return { label: "Continuing after max turns", detail: attempt, tone: "warning" };
  }

  return { label: "Retry scheduled", detail: attempt, tone: "warning" };
}
