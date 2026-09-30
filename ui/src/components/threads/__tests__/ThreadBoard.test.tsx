import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { ThreadBoard } from "../ThreadBoard";
import type { ThreadListItem } from "../../../api/threads";
import React from "react";

vi.mock("../../../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "comp-1",
    selectedCompany: { id: "comp-1", name: "Test Corp", issuePrefix: "TC" },
  }),
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/router")>("../../../lib/router");
  return {
    ...actual,
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
      <a href={to}>{children}</a>
    ),
  };
});

const makeThread = (overrides: Partial<ThreadListItem> = {}): ThreadListItem => ({
  id: "t-default",
  title: "Default thread",
  status: "active",
  scopeType: null,
  scopeId: null,
  scopeName: null,
  tags: [],
  entryCount: 0,
  pendingItemCount: 0,
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00Z",
  lastEntryAt: null,
  lastEntryInputType: null,
  phase: "discuss",
  visibility: "company",
  ownerUserId: null,
  originSource: null,
  intent: null,
  goalId: null,
  autonomyLevel: null,
  summaryText: null,
  summaryNext: null,
  subtype: "normal",
  shareToken: null,
  participants: [],
  allowMemoryExtraction: true,
  ...overrides,
});

describe("ThreadBoard", () => {
  it("renders all 4 phase column headers", () => {
    renderWithProviders(
      <ThreadBoard threads={[]} onNewThread={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    expect(screen.getByText("Discuss")).toBeInTheDocument();
    expect(screen.getByText("Scope")).toBeInTheDocument();
    expect(screen.getByText("Assign")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("renders Unlisted lane even when empty", () => {
    renderWithProviders(
      <ThreadBoard threads={[]} onNewThread={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    expect(screen.getByTestId("unlisted-lane")).toBeInTheDocument();
  });

  it("places threads in correct phase columns", () => {
    const threads = [
      makeThread({ id: "t1", title: "Auth discussion", phase: "discuss" }),
      makeThread({ id: "t2", title: "Roadmap scoping", phase: "scope" }),
      makeThread({ id: "t3", title: "Sprint assign", phase: "assign" }),
      makeThread({ id: "t4", title: "Shipped feature", phase: "done" }),
    ];

    renderWithProviders(
      <ThreadBoard threads={threads} onNewThread={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    // Each card should appear under the correct column
    expect(screen.getByText("Auth discussion")).toBeInTheDocument();
    expect(screen.getByText("Roadmap scoping")).toBeInTheDocument();
    expect(screen.getByText("Sprint assign")).toBeInTheDocument();
    expect(screen.getByText("Shipped feature")).toBeInTheDocument();
  });

  it("does not render drag handles (no DnD in v1)", () => {
    renderWithProviders(
      <ThreadBoard threads={[makeThread()]} onNewThread={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    expect(screen.queryByRole("button", { name: /drag/i })).not.toBeInTheDocument();
  });

  it("renders compact discussion card metadata without changing the card link", () => {
    renderWithProviders(
      <ThreadBoard
        threads={[
          makeThread({
            id: "t1",
            title: "Clarify pricing page objections",
            pendingItemCount: 3,
            lastEntryInputType: "voice",
            scopeType: "department",
            scopeName: "Growth",
            visibility: "company",
            summaryNext: "Ready for approval before task creation.",
            participantPreview: [
              { principalType: "user", principalId: "user-1", name: "TK", role: "owner" },
            ],
            participantCount: 1,
            linkCount: 1,
          }),
        ]}
        onNewThread={vi.fn()}
      />,
      { initialEntries: ["/TC/discussions"] },
    );

    expect(screen.getByLabelText("3 items need review")).toBeInTheDocument();
    expect(screen.getByLabelText("Source: Voice")).toBeInTheDocument();
    expect(screen.getByLabelText("Department: Growth")).toBeInTheDocument();
    expect(screen.getByLabelText("Company visibility")).toBeInTheDocument();
    expect(screen.getByLabelText("1 linked thread")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /clarify pricing page objections/i }),
    ).toHaveAttribute("href", "/discussions/t1");
  });
});
