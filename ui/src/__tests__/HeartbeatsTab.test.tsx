import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./test-utils";
import type { InstanceSchedulerHeartbeatAgent } from "@armyofagents/shared";

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    listInstanceSchedulerAgents: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    get: vi.fn(),
    update: vi.fn(),
  },
}));

import { HeartbeatsTab } from "../components/settings/HeartbeatsTab";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";

function makeSchedulerAgent(
  overrides: Partial<InstanceSchedulerHeartbeatAgent> = {},
): InstanceSchedulerHeartbeatAgent {
  return {
    id: "agent-1",
    companyId: "comp-1",
    companyName: "Acme",
    companyIssuePrefix: "ACM",
    agentName: "Alpha",
    agentUrlKey: "alpha",
    role: "engineer",
    title: "Engineer",
    status: "active",
    adapterType: "claude_local",
    intervalSec: 60,
    heartbeatEnabled: true,
    schedulerActive: true,
    lastHeartbeatAt: new Date("2026-04-20T00:00:00Z"),
    ...overrides,
  };
}

describe("HeartbeatsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentsApi.get).mockResolvedValue({
      id: "agent-1",
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
    } as any);
    vi.mocked(agentsApi.update).mockResolvedValue({} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows loading state", () => {
    vi.mocked(heartbeatsApi.listInstanceSchedulerAgents).mockReturnValue(
      new Promise(() => {}),
    );
    renderWithProviders(<HeartbeatsTab />);
    expect(screen.getByText(/loading scheduler heartbeats/i)).toBeInTheDocument();
  });

  it("renders active/disabled counts and agent rows", async () => {
    vi.mocked(heartbeatsApi.listInstanceSchedulerAgents).mockResolvedValue([
      makeSchedulerAgent({ id: "a-1", agentName: "Alpha", schedulerActive: true, heartbeatEnabled: true }),
      makeSchedulerAgent({ id: "a-2", agentName: "Bravo", schedulerActive: false, heartbeatEnabled: false }),
    ]);

    renderWithProviders(<HeartbeatsTab />);

    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();

    expect(screen.getByTestId("active-count")).toHaveTextContent("1");
    expect(screen.getByTestId("disabled-count")).toHaveTextContent("1");
  });

  it("renders empty state when no agents", async () => {
    vi.mocked(heartbeatsApi.listInstanceSchedulerAgents).mockResolvedValue([]);
    renderWithProviders(<HeartbeatsTab />);
    expect(
      await screen.findByText(/no scheduler heartbeats/i),
    ).toBeInTheDocument();
  });

  it("toggles an agent heartbeat when clicking the toggle button", async () => {
    const user = userEvent.setup();
    vi.mocked(heartbeatsApi.listInstanceSchedulerAgents).mockResolvedValue([
      makeSchedulerAgent({ id: "agent-1", heartbeatEnabled: true }),
    ]);

    renderWithProviders(<HeartbeatsTab />);

    const disableBtn = await screen.findByRole("button", {
      name: /disable timer heartbeat/i,
    });
    await user.click(disableBtn);

    await waitFor(() => {
      expect(agentsApi.update).toHaveBeenCalledWith(
        "agent-1",
        expect.objectContaining({
          runtimeConfig: expect.objectContaining({
            heartbeat: expect.objectContaining({ enabled: false }),
          }),
        }),
        "comp-1",
      );
    });
  });

  it("hides Disable All button when no agents enabled", async () => {
    vi.mocked(heartbeatsApi.listInstanceSchedulerAgents).mockResolvedValue([
      makeSchedulerAgent({ heartbeatEnabled: false, schedulerActive: false }),
    ]);

    renderWithProviders(<HeartbeatsTab />);

    await screen.findByText("Alpha");
    expect(screen.queryByRole("button", { name: /disable all/i })).toBeNull();
  });

  it("confirms and disables all enabled agents when Disable All clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(heartbeatsApi.listInstanceSchedulerAgents).mockResolvedValue([
      makeSchedulerAgent({ id: "a-1", agentName: "Alpha", heartbeatEnabled: true }),
      makeSchedulerAgent({ id: "a-2", agentName: "Bravo", heartbeatEnabled: true }),
      makeSchedulerAgent({ id: "a-3", agentName: "Charlie", heartbeatEnabled: false }),
    ]);

    renderWithProviders(<HeartbeatsTab />);

    const btn = await screen.findByRole("button", { name: /disable all/i });
    await user.click(btn);

    const confirmBtn = await screen.findByRole("button", { name: /^disable all$/i });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(agentsApi.update).toHaveBeenCalledTimes(2);
    });
  });

  it("does not disable agents if confirmation is cancelled", async () => {
    const user = userEvent.setup();
    vi.mocked(heartbeatsApi.listInstanceSchedulerAgents).mockResolvedValue([
      makeSchedulerAgent({ id: "a-1", heartbeatEnabled: true }),
    ]);

    renderWithProviders(<HeartbeatsTab />);
    const btn = await screen.findByRole("button", { name: /disable all/i });
    await user.click(btn);

    const cancelBtn = await screen.findByRole("button", { name: /^cancel$/i });
    await user.click(cancelBtn);

    await new Promise((r) => setTimeout(r, 20));
    expect(agentsApi.update).not.toHaveBeenCalled();
  });
});
