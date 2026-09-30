import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommanderRosterTab } from "../components/team/CommanderRosterTab";
import { renderWithProviders, makeAgent, makeTrustScore } from "./test-utils";

vi.mock("../lib/router", () => ({ useNavigate: () => vi.fn() }));

describe("CommanderRosterTab", () => {
  it("renders agent cards", () => {
    const agents = [
      makeAgent({ id: "a1", name: "Alpha Bot", status: "running" }),
      makeAgent({ id: "a2", name: "Beta Bot",  status: "idle" }),
    ];
    renderWithProviders(
      <CommanderRosterTab
        agents={agents}
        trustScores={[]}
        isFounder={false}
        onNewAgent={vi.fn()}
      />,
    );
    expect(screen.getByText("Alpha Bot")).toBeTruthy();
    expect(screen.getByText("Beta Bot")).toBeTruthy();
  });

  it("shows New AoA Agent button for founders", () => {
    const onNewAgent = vi.fn();
    renderWithProviders(
      <CommanderRosterTab
        agents={[makeAgent()]}
        trustScores={[]}
        isFounder={true}
        onNewAgent={onNewAgent}
      />,
    );
    const btn = screen.getByRole("button", { name: /new aoa agent/i });
    expect(btn).toBeTruthy();
  });

  it("hides New AoA Agent button for non-founders", () => {
    renderWithProviders(
      <CommanderRosterTab
        agents={[makeAgent()]}
        trustScores={[]}
        isFounder={false}
        onNewAgent={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /new aoa agent/i })).toBeNull();
  });

  it("calls onNewAgent when button is clicked", async () => {
    const user = userEvent.setup();
    const onNewAgent = vi.fn();
    renderWithProviders(
      <CommanderRosterTab
        agents={[makeAgent()]}
        trustScores={[]}
        isFounder={true}
        onNewAgent={onNewAgent}
      />,
    );
    await user.click(screen.getByRole("button", { name: /new aoa agent/i }));
    expect(onNewAgent).toHaveBeenCalledOnce();
  });

  it("shows trust score badge when trust data present", () => {
    const agent = makeAgent({ id: "a1" });
    const trust = makeTrustScore({ agentId: "a1", currentScore: 75 });
    renderWithProviders(
      <CommanderRosterTab
        agents={[agent]}
        trustScores={[trust]}
        isFounder={false}
        onNewAgent={vi.fn()}
      />,
    );
    // formatTrustScorePercent(75) → "75%"
    expect(screen.getByText("75%")).toBeTruthy();
  });

  it("renders budget bar with spend/limit", () => {
    const agent = makeAgent({
      id: "a1",
      spentMonthlyCents: 500,
      budgetMonthlyCents: 1000,
    });
    renderWithProviders(
      <CommanderRosterTab
        agents={[agent]}
        trustScores={[]}
        isFounder={false}
        onNewAgent={vi.fn()}
      />,
    );
    // $5 / $10
    expect(screen.getByText("$5 / $10")).toBeTruthy();
  });
});
