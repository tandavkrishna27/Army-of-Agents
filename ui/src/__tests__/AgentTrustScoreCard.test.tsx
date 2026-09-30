import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./test-utils";
import { AgentTrustScoreCard } from "../components/AgentTrustScoreCard";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <div>{children}</div>,
  TooltipTrigger: ({ children }: any) => <div>{children}</div>,
  TooltipContent: ({ children }: any) => <div>{children}</div>,
}));

describe("AgentTrustScoreCard", () => {
  it("shows no data yet for a new agent", () => {
    renderWithProviders(<AgentTrustScoreCard score={null} />);

    expect(screen.getByText("No data yet")).toBeInTheDocument();
  });

  it("renders an upward trend when recent performance is above overall score", () => {
    renderWithProviders(
      <AgentTrustScoreCard
        score={{
          id: "ts-1",
          companyId: "comp-1",
          agentId: "agent-1",
          totalCompleted: 40,
          approvedWithoutChanges: 28,
          recentCompleted: 20,
          recentApproved: 18,
          currentScore: 65,
          createdAt: new Date(),
          updatedAt: new Date(),
        }}
      />,
    );

    expect(screen.getByTestId("trust-trend")).toHaveAttribute("data-trend", "up");
    expect(screen.getByText("Recent performance: Last 20 tasks: 18 of 20 approved (90%)")).toBeInTheDocument();
  });
});
