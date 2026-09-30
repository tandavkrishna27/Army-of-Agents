import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, makeCompany } from "./test-utils";
import { LobbyCompanyCard } from "../components/LobbyCompanyCard";
import type { CompanyStats } from "@/api/companies";

type StatEntry = CompanyStats[string];

function makeStats(overrides: Partial<StatEntry> = {}): StatEntry {
  return {
    agentCount: 0,
    issueCount: 0,
    pendingApprovalCount: 0,
    unreadNotificationCount: 0,
    ...overrides,
  };
}

describe("LobbyCompanyCard", () => {
  it("renders the company name", () => {
    renderWithProviders(
      <LobbyCompanyCard
        company={makeCompany({ name: "Acme Inc" })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("Acme Inc")).toBeInTheDocument();
  });

  it("renders the issue prefix in mono", () => {
    const { container } = renderWithProviders(
      <LobbyCompanyCard
        company={makeCompany({ name: "Acme Inc", issuePrefix: "ACM" })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("ACM")).toBeInTheDocument();
    const prefix = container.querySelector(".font-mono");
    expect(prefix).toBeTruthy();
  });

  it("renders agent count in the sub-line", () => {
    renderWithProviders(
      <LobbyCompanyCard
        company={makeCompany()}
        stats={makeStats({ agentCount: 5 })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/5 agents/i)).toBeInTheDocument();
  });

  it("uses singular form when agent count is 1", () => {
    renderWithProviders(
      <LobbyCompanyCard
        company={makeCompany()}
        stats={makeStats({ agentCount: 1 })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/^1 agent$/)).toBeInTheDocument();
  });

  it("renders the 3 stat cells (Active tasks · Pending approvals · Tasks today)", () => {
    renderWithProviders(
      <LobbyCompanyCard
        company={makeCompany()}
        stats={makeStats({ agentCount: 4, issueCount: 38, pendingApprovalCount: 3 })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/active tasks/i)).toBeInTheDocument();
    expect(screen.getByText(/pending approvals/i)).toBeInTheDocument();
    expect(screen.getByText(/tasks today/i)).toBeInTheDocument();
    expect(screen.getByText("38")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("calls onClick when the card is clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithProviders(
      <LobbyCompanyCard company={makeCompany()} onClick={onClick} />,
    );
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders skeleton placeholders when statsLoading is true", () => {
    const { container } = renderWithProviders(
      <LobbyCompanyCard
        company={makeCompany()}
        statsLoading
        onClick={vi.fn()}
      />,
    );
    // Skeletons render with the animate-shimmer gradient-sweep class
    // (replaced animate-pulse in the UI overhaul, §9.9 Loading-B).
    expect(container.querySelectorAll(".animate-shimmer").length).toBeGreaterThan(0);
  });

  // Lobby v4: card uses solid bg-card surface + brand-red hover state
  // per design-system §10 (cards) + §9.1 (focus ring). No top color stripe.
  it("uses the bg-card surface with brand-red hover state", () => {
    const { container } = renderWithProviders(
      <LobbyCompanyCard company={makeCompany()} onClick={vi.fn()} />,
    );
    const button = container.querySelector("button");
    expect(button?.className).toMatch(/bg-card(?!-2)/);
    expect(button?.className).toMatch(/hover:border-brand/);
    expect(button?.className).toMatch(/focus-visible:ring-brand-focus-ring/);
  });

  // Lobby v4: card hover scales subtly (1.005, smaller than the prior 1.02)
  // and motion-reduce reverts the transform.
  it("applies subtle hover scale and motion-reduce override class", () => {
    const { container } = renderWithProviders(
      <LobbyCompanyCard company={makeCompany()} onClick={vi.fn()} />,
    );
    const button = container.querySelector("button");
    expect(button?.className).toMatch(/hover:scale-\[1\.\d+\]/);
    expect(button?.className).toContain("motion-reduce:hover:scale-100");
  });

  // Lobby v4: shows live/pending/failed pills conditionally; pending pill
  // appears when pendingApprovalCount > 0.
  it("shows the pending pill when pending approvals > 0", () => {
    renderWithProviders(
      <LobbyCompanyCard
        company={makeCompany()}
        stats={makeStats({ pendingApprovalCount: 3 })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/3 pending/i)).toBeInTheDocument();
  });

  it("shows the unread notifications pill when unread notifications > 0", () => {
    renderWithProviders(
      <LobbyCompanyCard
        company={makeCompany()}
        stats={makeStats({ unreadNotificationCount: 9 })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/9 unread notifications/i)).toBeInTheDocument();
    expect(screen.getByText(/9 unread/i)).toBeInTheDocument();
  });

  it("does NOT show the pending pill when count is 0", () => {
    renderWithProviders(
      <LobbyCompanyCard
        company={makeCompany()}
        stats={makeStats({ pendingApprovalCount: 0 })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByText(/pending/i, { selector: "span" })).not.toBeInTheDocument();
  });

  it("does NOT show the unread notifications pill when count is 0", () => {
    renderWithProviders(
      <LobbyCompanyCard
        company={makeCompany()}
        stats={makeStats({ unreadNotificationCount: 0 })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/unread notifications/i)).not.toBeInTheDocument();
  });
});
