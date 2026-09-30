import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MemoryRetrievalRowApi } from "../../../api/memoryRetrievals";

const listForIssue = vi.fn();

vi.mock("../../../api/memoryRetrievals", async () => {
  const actual = await vi.importActual<typeof import("../../../api/memoryRetrievals")>(
    "../../../api/memoryRetrievals",
  );
  return {
    ...actual,
    memoryRetrievalsApi: {
      listForIssue: (companyId: string, issueId: string, opts?: { limit?: number }) =>
        listForIssue(companyId, issueId, opts),
    },
  };
});

import { MemorySection } from "../sections/MemorySection";

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function row(overrides: Partial<MemoryRetrievalRowApi> = {}): MemoryRetrievalRowApi {
  return {
    id: overrides.id ?? "r-1",
    companyId: "co-1",
    agentId: "agent-1",
    runId: "run-1",
    taskId: "issue-1",
    triggeredBy: overrides.triggeredBy ?? "agent_search",
    query: "brand voice",
    itemId: "item-1",
    similarityScore: "0.92",
    rank: 1,
    shownToAgent: true,
    createdAt: "2026-05-01T00:00:00.000Z",
    itemTitle: overrides.itemTitle ?? "Brand voice",
    itemContent: "Casual, direct.",
    itemCategory: overrides.itemCategory ?? "preference",
    itemLayer: overrides.itemLayer ?? "domain",
    itemStatus: "approved",
    itemPinnedToSkill: false,
    ...overrides,
  };
}

describe("MemorySection", () => {
  beforeEach(() => {
    listForIssue.mockReset();
  });

  it("renders the empty state when no retrievals", async () => {
    listForIssue.mockResolvedValue([]);

    renderWithQuery(
      <MemorySection issueId="issue-1" companyId="co-1" companyPrefix="acme" />,
    );

    expect(await screen.findByTestId("memory-section-empty")).toBeInTheDocument();
    expect(screen.getByText("No memory used yet")).toBeInTheDocument();
    expect(screen.getByText("Retrievals from future runs will appear here.")).toBeInTheDocument();
  });

  it("groups retrievals by triggeredBy (auto / agent-pulled / skill)", async () => {
    listForIssue.mockResolvedValue([
      row({ id: "r-auto", triggeredBy: "auto", itemTitle: "Auto item" }),
      row({ id: "r-search", triggeredBy: "agent_search", itemTitle: "Searched item" }),
      row({ id: "r-get", triggeredBy: "agent_get", itemTitle: "Fetched item" }),
      row({ id: "r-skill", triggeredBy: "skill_materialize", itemTitle: "Pinned item" }),
    ]);

    renderWithQuery(
      <MemorySection issueId="issue-1" companyId="co-1" companyPrefix="acme" />,
    );

    await screen.findByTestId("memory-section");

    // Auto group
    expect(screen.getByTestId("memory-group-auto")).toBeInTheDocument();
    expect(screen.getByText("Auto item")).toBeInTheDocument();

    // Agent-pulled group: search + get folded together
    expect(screen.getByTestId("memory-group-agent-pulled")).toBeInTheDocument();
    expect(screen.getByText("Searched item")).toBeInTheDocument();
    expect(screen.getByText("Fetched item")).toBeInTheDocument();

    // Skill group rendered (collapsed by default — content present in DOM)
    expect(screen.getByTestId("memory-group-skill")).toBeInTheDocument();
    expect(screen.getByText("Pinned item")).toBeInTheDocument();
  });

  it("renders similarity percentage when present", async () => {
    listForIssue.mockResolvedValue([
      row({ similarityScore: "0.873" }),
    ]);

    renderWithQuery(
      <MemorySection issueId="issue-1" companyId="co-1" companyPrefix="acme" />,
    );

    expect(await screen.findByText("87%")).toBeInTheDocument();
  });

  it("shows 'filtered' badge when shownToAgent=false (returned by search but RBAC-filtered)", async () => {
    listForIssue.mockResolvedValue([
      row({ shownToAgent: false }),
    ]);

    renderWithQuery(
      <MemorySection issueId="issue-1" companyId="co-1" companyPrefix="acme" />,
    );

    expect(await screen.findByText("filtered")).toBeInTheDocument();
  });

  it("renders '(item deleted)' when the joined memory item is null", async () => {
    listForIssue.mockResolvedValue([
      row({
        itemTitle: null,
        itemContent: null,
        itemCategory: null,
        itemLayer: null,
        itemStatus: null,
      }),
    ]);

    renderWithQuery(
      <MemorySection issueId="issue-1" companyId="co-1" companyPrefix="acme" />,
    );

    expect(await screen.findByText("(item deleted)")).toBeInTheDocument();
  });

  it("links each row to a memory-item deep link when itemId present", async () => {
    listForIssue.mockResolvedValue([
      row({ itemId: "item-77", itemTitle: "Linked item" }),
    ]);

    const { container } = renderWithQuery(
      <MemorySection issueId="issue-1" companyId="co-1" companyPrefix="acme" />,
    );

    await screen.findByText("Linked item");
    const link = container.querySelector("[data-testid='memory-retrieval-row']");
    expect(link).toHaveAttribute(
      "href",
      "/acme/memory/explore?item=item-77&type=memory_item",
    );
  });
});
