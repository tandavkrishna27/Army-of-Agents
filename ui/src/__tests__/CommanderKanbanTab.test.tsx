import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { CommanderKanbanTab, agentStatusToColumn } from "../components/team/CommanderKanbanTab";
import { renderWithProviders, makeAgent, makeLiveRun } from "./test-utils";

describe("agentStatusToColumn (pure)", () => {
  it("maps running → running", () => expect(agentStatusToColumn("running")).toBe("running"));
  it("maps pending_approval → approval", () => expect(agentStatusToColumn("pending_approval")).toBe("approval"));
  it("maps error → error", () => expect(agentStatusToColumn("error")).toBe("error"));
  it("maps paused → paused", () => expect(agentStatusToColumn("paused")).toBe("paused"));
  it("maps idle → idle", () => expect(agentStatusToColumn("idle")).toBe("idle"));
  it("maps active → idle (fallback)", () => expect(agentStatusToColumn("active")).toBe("idle"));
  it("maps archived → idle (fallback)", () => expect(agentStatusToColumn("archived")).toBe("idle"));
  it("maps unknown → idle (fallback)", () => expect(agentStatusToColumn("anything")).toBe("idle"));
});

describe("CommanderKanbanTab rendering", () => {
  it("renders all five column headers", () => {
    renderWithProviders(<CommanderKanbanTab agents={[]} liveRuns={[]} />);
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Awaiting Approval")).toBeTruthy();
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
  });

  it("places a running agent in the Running column with live indicator", () => {
    const agent = makeAgent({ id: "a1", name: "Speedy", status: "running" });
    const run = makeLiveRun({
      agentId: "a1",
      issueId: "ABCDEF123456",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    renderWithProviders(<CommanderKanbanTab agents={[agent]} liveRuns={[run]} />);
    // Task title uses last 6 chars of issueId
    expect(screen.getByText("Task #123456")).toBeTruthy();
    // Agent name shows in footer
    expect(screen.getByText("Speedy")).toBeTruthy();
  });

  it("places a paused agent in the Paused column", () => {
    const agent = makeAgent({ id: "a2", name: "Paused Bot", status: "paused" });
    renderWithProviders(<CommanderKanbanTab agents={[agent]} liveRuns={[]} />);
    expect(screen.getByText("Paused Bot")).toBeTruthy();
    // "Paused" appears in both column header and status line — both should exist
    expect(screen.getAllByText("Paused").length).toBeGreaterThanOrEqual(2);
  });

  it("shows empty text when a column has no agents", () => {
    renderWithProviders(<CommanderKanbanTab agents={[]} liveRuns={[]} />);
    expect(screen.getByText("No idle agents")).toBeTruthy();
    expect(screen.getByText("Nothing running")).toBeTruthy();
    expect(screen.getByText("No pending approvals")).toBeTruthy();
    expect(screen.getByText("No errors")).toBeTruthy();
    expect(screen.getByText("No agents paused")).toBeTruthy();
  });

  it("shows decision-needed callout for approval-state agent", () => {
    const agent = makeAgent({ id: "a3", status: "pending_approval" });
    renderWithProviders(<CommanderKanbanTab agents={[agent]} liveRuns={[]} />);
    expect(screen.getByText(/decision needed before continuing/i)).toBeTruthy();
  });

  it("shows error callout for error-state agent", () => {
    const agent = makeAgent({ id: "a4", status: "error" });
    renderWithProviders(<CommanderKanbanTab agents={[agent]} liveRuns={[]} />);
    expect(screen.getByText(/exit error.*check agent logs/i)).toBeTruthy();
  });
});
