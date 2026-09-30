import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { IssueMonitor } from "@armyofagents/shared";
import { IssueMonitorActivityCard } from "./IssueMonitorActivityCard";

function monitor(overrides: Partial<IssueMonitor> = {}): IssueMonitor {
  return {
    id: "monitor-1",
    companyId: "company-1",
    issueId: "issue-1",
    agentId: "agent-1",
    status: "scheduled",
    kind: "handoff",
    scheduledBy: "board",
    nextCheckAt: new Date("2026-05-12T12:30:00Z"),
    lastTriggeredAt: null,
    clearedAt: null,
    clearReason: null,
    attemptCount: 0,
    maxAttempts: 2,
    timeoutAt: null,
    notes: "Check the task handoff.",
    externalRef: null,
    recoveryPolicy: null,
    metadata: null,
    createdAt: new Date("2026-05-12T10:00:00Z"),
    updatedAt: new Date("2026-05-12T10:00:00Z"),
    ...overrides,
  };
}

describe("IssueMonitorActivityCard", () => {
  it("shows scheduled monitor timing and attempts", () => {
    render(<IssueMonitorActivityCard monitor={monitor()} />);

    expect(screen.getByText("Monitor scheduled")).toBeTruthy();
    expect(screen.getByText(/May 12, 2026/)).toBeTruthy();
    expect(screen.getByText("0 / 2 attempts")).toBeTruthy();
  });

  it("shows triggered state", () => {
    render(
      <IssueMonitorActivityCard
        monitor={monitor({
          status: "triggered",
          nextCheckAt: null,
          lastTriggeredAt: new Date("2026-05-12T12:30:00Z"),
          attemptCount: 1,
        })}
      />,
    );

    expect(screen.getByText("Monitor triggered")).toBeTruthy();
    expect(screen.getByText("1 / 2 attempts")).toBeTruthy();
  });

  it("shows cleared reason including max attempts exhausted", () => {
    render(
      <IssueMonitorActivityCard
        monitor={monitor({
          status: "cleared",
          nextCheckAt: null,
          clearedAt: new Date("2026-05-12T13:00:00Z"),
          clearReason: "max_attempts_exhausted",
          attemptCount: 2,
        })}
      />,
    );

    expect(screen.getByText("Monitor cleared")).toBeTruthy();
    expect(screen.getByText("Max attempts exhausted")).toBeTruthy();
    expect(screen.getByText("2 / 2 attempts")).toBeTruthy();
  });
});
