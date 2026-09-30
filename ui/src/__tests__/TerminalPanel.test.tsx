import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock xterm BEFORE importing TerminalPanel
const mockTerminal = {
  open: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
  dispose: vi.fn(),
  loadAddon: vi.fn(),
  onData: vi.fn(),
};

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(() => mockTerminal),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(() => ({
    fit: vi.fn(),
    dispose: vi.fn(),
  })),
}));

// Mock CSS import
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const mockLiveRuns = vi.fn().mockResolvedValue([]);
const mockLog = vi.fn().mockResolvedValue({ runId: "r1", store: "memory", logRef: "", content: "", nextOffset: undefined });
const mockEvents = vi.fn().mockResolvedValue([]);
const mockRunsForIssue = vi.fn().mockResolvedValue([]);

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForIssue: (...args: unknown[]) => mockLiveRuns(...args),
    log: (...args: unknown[]) => mockLog(...args),
    events: (...args: unknown[]) => mockEvents(...args),
  },
}));

vi.mock("@/api/activity", () => ({
  activityApi: {
    runsForIssue: (...args: unknown[]) => mockRunsForIssue(...args),
  },
}));

import { TerminalPanel } from "../components/workspace/tools/TerminalPanel";

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("TerminalPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLiveRuns.mockResolvedValue([]);
    mockRunsForIssue.mockResolvedValue([]);
  });

  it("shows placeholder when no runs exist", async () => {
    renderWithQuery(<TerminalPanel issueId="issue-1" companyId="comp-1" />);

    await waitFor(() => {
      expect(screen.getByText("No run output yet")).toBeInTheDocument();
    });
  });

  it("creates xterm and writes log content for a completed run", async () => {
    mockLiveRuns.mockResolvedValue([]);
    mockRunsForIssue.mockResolvedValue([
      { runId: "run-1", status: "completed", agentId: "a1", startedAt: null, finishedAt: "2026-04-01T10:00:00Z", createdAt: "2026-04-01T09:00:00Z", invocationSource: "comment", usageJson: null, resultJson: null },
    ]);
    mockLog.mockResolvedValue({ runId: "run-1", store: "memory", logRef: "", content: "Hello world\nDone.", nextOffset: undefined });

    renderWithQuery(<TerminalPanel issueId="issue-1" companyId="comp-1" />);

    await waitFor(() => {
      expect(mockTerminal.open).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockTerminal.write).toHaveBeenCalledWith("Hello world\nDone.");
    });
  });

  it("disposes terminal on unmount", async () => {
    mockRunsForIssue.mockResolvedValue([
      { runId: "run-1", status: "completed", agentId: "a1", startedAt: null, finishedAt: "2026-04-01T10:00:00Z", createdAt: "2026-04-01T09:00:00Z", invocationSource: "comment", usageJson: null, resultJson: null },
    ]);
    mockLog.mockResolvedValue({ runId: "run-1", store: "memory", logRef: "", content: "x", nextOffset: undefined });

    const { unmount } = renderWithQuery(<TerminalPanel issueId="issue-1" companyId="comp-1" />);

    await waitFor(() => {
      expect(mockTerminal.open).toHaveBeenCalled();
    });

    unmount();
    expect(mockTerminal.dispose).toHaveBeenCalled();
  });
});
