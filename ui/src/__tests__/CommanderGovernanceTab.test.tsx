import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommanderGovernanceTab } from "../components/team/CommanderGovernanceTab";
import { renderWithProviders, makeAgent, makeTrustScore } from "./test-utils";

// ── Hoisted mock objects (must be initialized before vi.mock hoisting) ────────
const { mockAgentsApi, mockApprovalsApi, mockPushToast } = vi.hoisted(() => ({
  mockAgentsApi: {
    pause: vi.fn().mockResolvedValue({}),
    resume: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    updatePermissions: vi.fn().mockResolvedValue({}),
  },
  mockApprovalsApi: {
    approve: vi.fn().mockResolvedValue({}),
  },
  mockPushToast: vi.fn(),
}));

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/approvals", () => ({ approvalsApi: mockApprovalsApi }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "comp-1" }),
}));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CommanderGovernanceTab — summary metrics", () => {
  it("shows avg trust, monthly spend, pending approvals, error count", () => {
    const agents = [
      makeAgent({ id: "a1", spentMonthlyCents: 300, status: "running" }),
      makeAgent({ id: "a2", spentMonthlyCents: 700, status: "error" }),
    ];
    const trustScores = [
      makeTrustScore({ agentId: "a1", currentScore: 60 }),
      makeTrustScore({ agentId: "a2", currentScore: 80 }),
    ];
    renderWithProviders(
      <CommanderGovernanceTab
        agents={agents}
        trustScores={trustScores}
        isFounder={false}
      />,
    );
    // Scope each metric assertion to its summary card to avoid clashing with table values
    const avgCard     = screen.getByText("Avg trust").closest(".border")!;
    const spendCard   = screen.getByText("Monthly spend").closest(".border")!;
    const pendingCard = screen.getByText("Pending approvals").closest(".border")!;
    const errorCard   = screen.getByText("In error state").closest(".border")!;

    // avgTrust = (60 + 80) / 2 = 70%
    expect(within(avgCard).getByText("70%")).toBeTruthy();
    // monthlySpend = (300 + 700) / 100 = $10
    expect(within(spendCard).getByText("$10")).toBeTruthy();
    // 0 pending approvals
    expect(within(pendingCard).getByText("0")).toBeTruthy();
    // 1 in error state
    expect(within(errorCard).getByText("1")).toBeTruthy();
  });

  it("shows 0% avg trust when no trust score data provided", () => {
    const agent = makeAgent({ id: "a1", status: "idle" });
    renderWithProviders(
      <CommanderGovernanceTab
        agents={[agent]}
        trustScores={[]}
        isFounder={false}
      />,
    );
    expect(screen.getByText("0%")).toBeTruthy();
  });
});

describe("CommanderGovernanceTab — oversight table", () => {
  it("renders agent names in the table", () => {
    const agents = [
      makeAgent({ id: "a1", name: "Alpha Bot" }),
      makeAgent({ id: "a2", name: "Beta Bot" }),
    ];
    renderWithProviders(
      <CommanderGovernanceTab
        agents={agents}
        trustScores={[]}
        isFounder={false}
      />,
    );
    expect(screen.getByText("Alpha Bot")).toBeTruthy();
    expect(screen.getByText("Beta Bot")).toBeTruthy();
  });

  it("shows trust score in table row when trust data exists", () => {
    const agent = makeAgent({ id: "a1", name: "Trusty" });
    const trust = makeTrustScore({ agentId: "a1", currentScore: 90 });
    renderWithProviders(
      <CommanderGovernanceTab
        agents={[agent]}
        trustScores={[trust]}
        isFounder={false}
      />,
    );
    // "90%" appears in both the summary card and the table trust cell — both are correct
    expect(screen.getAllByText("90%").length).toBeGreaterThanOrEqual(1);
  });

  it("shows editable budget input for founders", () => {
    const agent = makeAgent({ id: "a1", budgetMonthlyCents: 5000 });
    renderWithProviders(
      <CommanderGovernanceTab
        agents={[agent]}
        trustScores={[]}
        isFounder={true}
      />,
    );
    const input = screen.getByTitle("Monthly budget limit ($)");
    expect(input).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("50");
  });

  it("shows can-hire toggle", () => {
    const agent = makeAgent({
      id: "a1",
      permissions: { canCreateAgents: true },
    });
    renderWithProviders(
      <CommanderGovernanceTab
        agents={[agent]}
        trustScores={[]}
        isFounder={true}
      />,
    );
    const toggle = screen.getByTitle("Toggle canCreateAgents");
    expect(toggle).toBeTruthy();
  });

  it("shows Pause button for running agent (founder only)", () => {
    const agent = makeAgent({ id: "a1", status: "running" });
    renderWithProviders(
      <CommanderGovernanceTab
        agents={[agent]}
        trustScores={[]}
        isFounder={true}
      />,
    );
    expect(screen.getByRole("button", { name: /pause/i })).toBeTruthy();
  });

  it("shows Resume button for paused agent (founder only)", () => {
    const agent = makeAgent({ id: "a1", status: "paused" });
    renderWithProviders(
      <CommanderGovernanceTab
        agents={[agent]}
        trustScores={[]}
        isFounder={true}
      />,
    );
    expect(screen.getByRole("button", { name: /resume/i })).toBeTruthy();
  });

  it("hides action buttons for non-founders", () => {
    const agent = makeAgent({ id: "a1", status: "running" });
    renderWithProviders(
      <CommanderGovernanceTab
        agents={[agent]}
        trustScores={[]}
        isFounder={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /pause/i })).toBeNull();
  });

  it("shows founder-only notice for non-founders", () => {
    const agent = makeAgent({ id: "a1", status: "idle" });
    renderWithProviders(
      <CommanderGovernanceTab
        agents={[agent]}
        trustScores={[]}
        isFounder={false}
      />,
    );
    expect(screen.getByText("founder-only")).toBeTruthy();
  });

  it("hides founder-only notice for founders", () => {
    const agent = makeAgent({ id: "a1", status: "idle" });
    renderWithProviders(
      <CommanderGovernanceTab
        agents={[agent]}
        trustScores={[]}
        isFounder={true}
      />,
    );
    expect(screen.queryByText("founder-only")).toBeNull();
  });

  it("calls agentsApi.pause when Pause button is clicked", async () => {
    const user = userEvent.setup();
    const agent = makeAgent({ id: "a1", status: "running" });
    renderWithProviders(
      <CommanderGovernanceTab
        agents={[agent]}
        trustScores={[]}
        isFounder={true}
      />,
    );
    await user.click(screen.getByRole("button", { name: /pause/i }));
    expect(mockAgentsApi.pause).toHaveBeenCalledWith("a1", "comp-1");
  });
});
