import { describe, expect, it } from "vitest";
import { getRunRetryState } from "./runRetryState";

describe("getRunRetryState", () => {
  it("labels scheduled retry runs", () => {
    expect(getRunRetryState({ status: "scheduled_retry" })).toMatchObject({
      label: "Retry scheduled",
      tone: "warning",
    });
  });

  it("labels max-turn continuation retries", () => {
    expect(
      getRunRetryState({
        status: "scheduled_retry",
        scheduledRetryReason: "max_turn_continuation",
        scheduledRetryAttempt: 1,
      }),
    ).toMatchObject({
      label: "Continuing after max turns",
      detail: "Attempt 1",
    });
  });

  it("labels exhausted max-turn continuations", () => {
    expect(
      getRunRetryState({
        status: "failed",
        scheduledRetryReason: "max_turn_continuation",
        errorCode: "max_turn_continuation_exhausted",
      }),
    ).toMatchObject({
      label: "Max-turn continuation exhausted",
      tone: "danger",
    });
  });

  it("labels cancelled stale scheduled retries", () => {
    expect(
      getRunRetryState({
        status: "cancelled",
        scheduledRetryReason: "max_turn_continuation",
        errorCode: "stale_scheduled_retry",
      }),
    ).toMatchObject({
      label: "Stale retry cancelled",
      tone: "muted",
    });
  });
});
