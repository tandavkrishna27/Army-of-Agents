import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { UnlistedLane } from "../UnlistedLane";
import React from "react";
import { api } from "../../../api/client";

// Mock fetch / api client
vi.mock("../../../api/client", () => ({
  api: {
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

vi.mock("../../../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "comp-1",
    selectedCompany: { id: "comp-1", name: "Test Corp", issuePrefix: "TC" },
  }),
}));

vi.mock("../../../api/threads", () => ({
  threadsApi: {
    list: vi.fn().mockResolvedValue({
      discussions: [
        {
          id: "thread-existing-1",
          title: "Existing thread alpha",
          status: "active",
          phase: "discuss",
          visibility: "company",
          ownerUserId: null,
          originSource: null,
          intent: null,
          goalId: null,
          autonomyLevel: null,
          summaryText: null,
          summaryNext: null,
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
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    }),
  },
}));

const makeItem = (overrides = {}) => ({
  id: "item-1",
  rawContent: "Meeting notes from product sync",
  originSource: "mcp" as const,
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

const makeThreadsById = (entries: Record<string, string>) =>
  new Map<string, string>(Object.entries(entries));

describe("UnlistedLane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.post).mockResolvedValue({ ok: true });
  });

  it("renders inbox items with triage buttons", () => {
    const items = [makeItem({ id: "item-1", rawContent: "User feedback about onboarding" })];

    renderWithProviders(
      <UnlistedLane inboxItems={items} onTriaged={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    expect(screen.getByText("User feedback about onboarding")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /make thread/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
  });

  it("renders routing attention and source metadata for inbox cards", () => {
    const items = [
      makeItem({
        id: "item-meta",
        rawContent: "Needs routing into the right discussion",
        originSource: "mcp",
        routerDecision: "suggest",
        suggestedThreadId: "t-1",
      }),
    ];

    renderWithProviders(
      <UnlistedLane
        inboxItems={items}
        onTriaged={vi.fn()}
        threadsById={makeThreadsById({ "t-1": "Existing thread" })}
      />,
      { initialEntries: ["/TC/discussions"] },
    );

    expect(screen.getByLabelText("1 item needs routing")).toBeInTheDocument();
    expect(screen.getByLabelText("Source: mcp")).toBeInTheDocument();
    expect(screen.getByLabelText("Suggested thread route")).toBeInTheDocument();
  });

  it("calls triage endpoint with 'dismiss' when Dismiss button is clicked", async () => {
    const user = userEvent.setup();
    const onTriaged = vi.fn();
    const items = [makeItem({ id: "item-99" })];

    renderWithProviders(
      <UnlistedLane inboxItems={items} onTriaged={onTriaged} />,
      { initialEntries: ["/TC/discussions"] },
    );

    const dismissBtn = screen.getByRole("button", { name: /dismiss/i });
    await user.click(dismissBtn);

    await waitFor(() => {
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        expect.stringContaining("item-99/triage"),
        expect.objectContaining({ action: "dismiss" }),
      );
    });
  });

  it("calls triage endpoint with 'make_thread' when Make thread button is clicked", async () => {
    const user = userEvent.setup();
    const items = [makeItem({ id: "item-42" })];

    renderWithProviders(
      <UnlistedLane inboxItems={items} onTriaged={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    const makeThreadBtn = screen.getByRole("button", { name: /make thread/i });
    await user.click(makeThreadBtn);

    await waitFor(() => {
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        expect.stringContaining("item-42/triage"),
        expect.objectContaining({ action: "make_thread" }),
      );
    });
  });

  it("shows empty state when no inbox items", () => {
    renderWithProviders(
      <UnlistedLane inboxItems={[]} onTriaged={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    expect(screen.getByText(/nothing to triage/i)).toBeInTheDocument();
  });

  it("renders 'Add to existing thread' button for each inbox item", () => {
    const items = [makeItem({ id: "item-1", rawContent: "Needs triage content" })];

    renderWithProviders(
      <UnlistedLane inboxItems={items} onTriaged={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    expect(
      screen.getByRole("button", { name: /add to existing thread/i }),
    ).toBeInTheDocument();
  });

  it("shows thread select dropdown when 'Add to' is clicked and calls attach on selection", async () => {
    const user = userEvent.setup();
    const onTriaged = vi.fn();
    const items = [makeItem({ id: "item-attach" })];

    renderWithProviders(
      <UnlistedLane inboxItems={items} onTriaged={onTriaged} />,
      { initialEntries: ["/TC/discussions"] },
    );

    // Open the dropdown
    const addToBtn = screen.getByRole("button", { name: /add to existing thread/i });
    await user.click(addToBtn);

    // The select should now be visible
    const select = await screen.findByTestId("add-to-thread-select");
    expect(select).toBeInTheDocument();

    // Select a thread
    await user.selectOptions(select, "thread-existing-1");

    await waitFor(() => {
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        expect.stringContaining("item-attach/triage"),
        expect.objectContaining({ action: "attach", threadId: "thread-existing-1" }),
      );
    });
  });

  // ── Task 2.2 — routing suggestion banner ──────────────────────────────────

  it("renders suggestion banner with thread title and Confirm button when routerDecision=suggest", () => {
    const items = [
      makeItem({
        id: "item-suggest",
        routerDecision: "suggest",
        suggestedThreadId: "t-1",
      }),
    ];
    const threadsById = makeThreadsById({ "t-1": "Onboarding revamp" });

    renderWithProviders(
      <UnlistedLane inboxItems={items} onTriaged={vi.fn()} threadsById={threadsById} />,
      { initialEntries: ["/TC/discussions"] },
    );

    expect(screen.getByTestId("inbox-suggestion-item-suggest")).toBeInTheDocument();
    expect(screen.getByText(/Onboarding revamp/)).toBeInTheDocument();
    expect(screen.getByTestId("inbox-suggestion-confirm-item-suggest")).toBeInTheDocument();
  });

  it("clicking Confirm fires triage('attach', suggestedThreadId) and calls onTriaged", async () => {
    const user = userEvent.setup();
    const onTriaged = vi.fn();
    const items = [
      makeItem({
        id: "item-confirm",
        routerDecision: "suggest",
        suggestedThreadId: "t-1",
      }),
    ];
    const threadsById = makeThreadsById({ "t-1": "Onboarding revamp" });

    renderWithProviders(
      <UnlistedLane inboxItems={items} onTriaged={onTriaged} threadsById={threadsById} />,
      { initialEntries: ["/TC/discussions"] },
    );

    const confirmBtn = screen.getByTestId("inbox-suggestion-confirm-item-confirm");
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        expect.stringContaining("item-confirm/triage"),
        expect.objectContaining({ action: "attach", threadId: "t-1" }),
      );
    });
    await waitFor(() => {
      expect(onTriaged).toHaveBeenCalledWith("item-confirm", "attach");
    });
  });

  it("does NOT render suggestion banner when routerDecision is null", () => {
    const items = [
      makeItem({
        id: "item-no-suggest",
        routerDecision: null,
        suggestedThreadId: null,
      }),
    ];

    renderWithProviders(
      <UnlistedLane inboxItems={items} onTriaged={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    expect(screen.queryByTestId("inbox-suggestion-item-no-suggest")).not.toBeInTheDocument();
    // Existing triage actions still present
    expect(screen.getByRole("button", { name: /make thread/i })).toBeInTheDocument();
  });

  it("does NOT render suggestion banner when routerDecision is absent (plain item)", () => {
    const items = [makeItem({ id: "item-plain" })];

    renderWithProviders(
      <UnlistedLane inboxItems={items} onTriaged={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    expect(screen.queryByTestId("inbox-suggestion-item-plain")).not.toBeInTheDocument();
  });

  it("renders gracefully when suggestedThreadId is not in the threadsById map", () => {
    const items = [
      makeItem({
        id: "item-missing-thread",
        routerDecision: "suggest",
        suggestedThreadId: "t-unknown",
      }),
    ];
    // Empty map — t-unknown not present
    const threadsById = makeThreadsById({});

    renderWithProviders(
      <UnlistedLane inboxItems={items} onTriaged={vi.fn()} threadsById={threadsById} />,
      { initialEntries: ["/TC/discussions"] },
    );

    // Banner still renders, falls back to the raw id
    expect(screen.getByTestId("inbox-suggestion-item-missing-thread")).toBeInTheDocument();
    expect(screen.getByText(/t-unknown/)).toBeInTheDocument();
    // No crash, Confirm button present
    expect(screen.getByTestId("inbox-suggestion-confirm-item-missing-thread")).toBeInTheDocument();
  });

  // ── Task 11 — suggest_new banner (Navigator new-thread suggestion) ─────────

  it("renders suggest_new banner with proposed title and Create thread button", () => {
    const items = [
      makeItem({
        id: "item-3",
        rawContent: "About the Acme contract renewal",
        routerDecision: "suggest_new",
        suggestedThreadTitle: "Acme contract renewal",
      }),
    ];

    renderWithProviders(
      <UnlistedLane inboxItems={items} onTriaged={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    const banner = screen.getByTestId("inbox-suggest-new-item-3");
    expect(banner).toBeInTheDocument();
    // Scope to the banner — rawContent preview also contains the title phrase.
    expect(within(banner).getByText(/Acme contract renewal/)).toBeInTheDocument();
    expect(screen.getByTestId("inbox-suggest-new-confirm-item-3")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-suggest-new-confirm-item-3")).toHaveTextContent("Create thread");
  });

  it("does NOT render suggest_new banner when routerDecision is null", () => {
    const items = [
      makeItem({
        id: "item-4",
        rawContent: "Some content",
        originSource: null,
        routerDecision: null,
      }),
    ];

    renderWithProviders(
      <UnlistedLane inboxItems={items} onTriaged={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    expect(screen.queryByTestId("inbox-suggest-new-item-4")).not.toBeInTheDocument();
  });
});
