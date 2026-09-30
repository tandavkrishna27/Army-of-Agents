import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { IssueRunLedger } from "./IssueRunLedger";

describe("IssueRunLedger", () => {
  it("shows retry labels beside task runs", () => {
    render(
      <MemoryRouter>
        <IssueRunLedger
          runs={[
            {
              runId: "run-1",
              status: "scheduled_retry",
              agentId: "agent-1",
              createdAt: "2026-05-12T10:00:00Z",
              startedAt: null,
              scheduledRetryReason: "max_turn_continuation",
              scheduledRetryAttempt: 2,
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Continuing after max turns")).toBeTruthy();
    expect(screen.getByText("Attempt 2")).toBeTruthy();
  });
});
