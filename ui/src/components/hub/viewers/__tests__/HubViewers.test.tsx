import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { HubItemListRow } from "@/api/hub-items";
import { HubViewerScaffold } from "../HubViewerScaffold";
import { JoinRequestBody } from "../JoinRequestBody";
import { SuggestionBody } from "../SuggestionBody";
import { ReminderBody } from "../ReminderBody";
import { MarketplaceOpBody } from "../MarketplaceOpBody";
import { RoutineBody } from "../RoutineBody";
import { GenericNotificationBody } from "../GenericNotificationBody";
import { UnlinkableEntityBody } from "../UnlinkableEntityBody";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: null,
  }),
}));

function row(overrides: Partial<HubItemListRow> = {}): HubItemListRow {
  return {
    id: "hub-1",
    companyId: "company-1",
    semanticType: "join_request",
    lane: "waiting_on_you",
    status: "open",
    priority: "high",
    title: "Scout wants to join Engineering",
    summary: "Requested by scout@example.com",
    sourceType: "join_request",
    sourceId: "jr-1",
    relatedEntityId: null,
    relatedEntityType: null,
    ownerUserId: null,
    ownerPool: "board",
    claimedByUserId: null,
    claimedAt: null,
    version: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    readAt: null,
    snoozedUntil: null,
    dismissedAt: null,
    groupKey: null,
    groupLabel: null,
    groupCount: null,
    scopeKey: null,
    slaAt: null,
    ...overrides,
  };
}

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("HubViewerScaffold", () => {
  it("renders the title + a meta chip row (priority, source, time)", () => {
    render(
      <HubViewerScaffold item={row()}>
        <div>body</div>
      </HubViewerScaffold>,
    );
    expect(screen.getByRole("heading", { name: /scout wants to join/i })).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });
});

describe("placeholder viewers", () => {
  it("JoinRequestBody shows the requester + Approve/Decline", () => {
    renderWithRouter(<JoinRequestBody item={row()} />);
    expect(screen.getByText(/requested by scout/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /decline/i })).toBeInTheDocument();
  });

  it("SuggestionBody shows the rationale summary + Apply/Open", () => {
    renderWithRouter(
      <SuggestionBody
        item={row({ semanticType: "suggestion", title: "Add a QA task", summary: "Coverage gap detected." })}
      />,
    );
    expect(screen.getByText(/coverage gap detected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /apply/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open/i })).toBeInTheDocument();
  });

  it("ReminderBody shows the reminder text + Open in Commander", () => {
    renderWithRouter(
      <ReminderBody
        item={row({ semanticType: "reminder", title: "Follow up with the design lead" })}
      />,
    );
    expect(screen.getByText(/follow up with the design lead/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open in commander/i })).toBeInTheDocument();
  });

  it("MarketplaceOpBody shows the op status + View", () => {
    renderWithRouter(
      <MarketplaceOpBody
        item={row({ semanticType: "marketplace_op", title: "Install completed: gstack", summary: "Operation finished." })}
      />,
    );
    expect(screen.getByText(/operation finished/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view/i })).toBeInTheDocument();
  });

  it("RoutineBody shows the failure summary + Open routine", () => {
    renderWithRouter(
      <RoutineBody
        item={row({ semanticType: "routine_outcome", title: "Nightly sync failed", summary: "exit code 1" })}
      />,
    );
    expect(screen.getByText(/exit code 1/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open routine/i })).toBeInTheDocument();
  });

  it("GenericNotificationBody shows the text + a single primary action", () => {
    renderWithRouter(
      <GenericNotificationBody
        item={row({ semanticType: "legacy_other", title: "Something happened", summary: "Details here." })}
      />,
    );
    expect(screen.getByText(/details here/i)).toBeInTheDocument();
  });

  it("UnlinkableEntityBody explains the entity is not linkable yet (no spinner)", () => {
    render(<UnlinkableEntityBody item={row({ semanticType: "legacy_other", title: "Artifact" })} kind="artifact" />);
    expect(screen.getByText(/not.*link/i)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
