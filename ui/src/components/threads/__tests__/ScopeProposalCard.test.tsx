import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { ScopeProposalCard } from "../ScopeProposalCard";
import type { ScopeProposalPayload } from "@armyofagents/shared";

function makeProposal(overrides: Partial<ScopeProposalPayload> = {}): ScopeProposalPayload {
  return {
    summary: "Ship the redesigned onboarding by EOQ.",
    proposedTasks: [
      {
        title: "Wireframe v3",
        description: "Iterate on welcome screen layout",
        suggestedAssigneeAgentId: null,
        suggestedDepartmentId: null,
      },
      {
        title: "Implement empty state",
        description: null,
        suggestedAssigneeAgentId: null,
        suggestedDepartmentId: null,
      },
    ],
    autoAdvanceAt: null,
    ...overrides,
  };
}

describe("ScopeProposalCard", () => {
  it("renders summary + proposed tasks", () => {
    renderWithProviders(
      <ScopeProposalCard
        proposal={makeProposal()}
        isActive={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText(/redesigned onboarding/i)).toBeInTheDocument();
    expect(screen.getByText("Wireframe v3")).toBeInTheDocument();
    expect(screen.getByText("Implement empty state")).toBeInTheDocument();
  });

  it("renders the Active Proposal badge when isActive is true", () => {
    renderWithProviders(
      <ScopeProposalCard
        proposal={makeProposal()}
        isActive={true}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByTestId("scope-proposal-active-badge")).toBeInTheDocument();
  });

  it("does not render the badge when isActive is false", () => {
    renderWithProviders(
      <ScopeProposalCard
        proposal={makeProposal()}
        isActive={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("scope-proposal-active-badge")).not.toBeInTheDocument();
  });

  it("fires onApprove when 'Start Scoping' is clicked", async () => {
    const onApprove = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <ScopeProposalCard
        proposal={makeProposal()}
        isActive
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("scope-proposal-approve"));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("fires onReject when 'Reject' is clicked", async () => {
    const onReject = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <ScopeProposalCard
        proposal={makeProposal()}
        isActive
        onApprove={vi.fn()}
        onReject={onReject}
      />,
    );
    await user.click(screen.getByTestId("scope-proposal-reject"));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("renders auto-advance hint when autoAdvanceAt is provided", () => {
    renderWithProviders(
      <ScopeProposalCard
        proposal={makeProposal({ autoAdvanceAt: "2026-06-01T00:00:00Z" })}
        autoAdvanceAt="2026-06-01T00:00:00Z"
        isActive
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByTestId("scope-proposal-auto-advance")).toBeInTheDocument();
  });
});
