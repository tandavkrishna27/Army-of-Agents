/**
 * CockpitApprovalsCard + useCockpitApprovalAction tests — Phase 3c + approval-families.
 *
 * Verifies:
 *   - Card renders items for all sources with correct source chip labels.
 *   - Approve on source="approval"          → approvalsApi.approve called (HC7).
 *   - Approve on source="memory"            → memoryApi.approve called (HC7).
 *   - Approve on source="discussion_item"   → discussionsApi.approveItems with { items:[{itemId, action}] } (HC7).
 *   - Deny on source="approval"             → approvalsApi.reject called.
 *   - Deny on source="memory"              → memoryApi.reject called.
 *   - Deny on source="discussion_item"     → discussionsApi.rejectItems with [itemId] array (HC4).
 *   - source="join_request"                → accessApi.approveJoinRequest / rejectJoinRequest.
 *   - source="memory_version"              → memoryApi.approveVersion/rejectVersion with relatedEntityId.
 *   - source="memory_archive"              → suggestionsApi.accept/dismiss with relatedEntityId.
 *   - source="runtime_tool_trust"          → ternary: 3 buttons (Always/Once/Deny);
 *                                            Always → confirmAction("allow_always"),
 *                                            Once   → confirmAction("allow_once"),
 *                                            Deny   → confirmAction("deny").
 *   - Binary items still render 2 buttons (Approve/Deny).
 *   - Card returns null when items is [].
 *   - data-testid="cockpit-card-approvals" is present.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CockpitApprovalItem } from "@armyofagents/shared";

// ── Mock API clients (HC7) — vi.hoisted to avoid TDZ with vi.mock factories ──

const mockApprovalsApprove = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockApprovalsReject = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockMemoryApprove = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockMemoryReject = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockMemoryApproveVersion = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockMemoryRejectVersion = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockDiscussionsApproveItems = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockDiscussionsRejectItems = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockAccessApproveJoinRequest = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockAccessRejectJoinRequest = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockSuggestionsAccept = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockSuggestionsDismiss = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockInternalAgentConfirmAction = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("../../../api/approvals", () => ({
  approvalsApi: {
    approve: mockApprovalsApprove,
    reject: mockApprovalsReject,
  },
}));

vi.mock("../../../api/memory", () => ({
  memoryApi: {
    approve: mockMemoryApprove,
    reject: mockMemoryReject,
    approveVersion: mockMemoryApproveVersion,
    rejectVersion: mockMemoryRejectVersion,
  },
}));

vi.mock("../../../api/discussions", () => ({
  discussionsApi: {
    approveItems: mockDiscussionsApproveItems,
    rejectItems: mockDiscussionsRejectItems,
  },
}));

vi.mock("../../../api/access", () => ({
  accessApi: {
    approveJoinRequest: mockAccessApproveJoinRequest,
    rejectJoinRequest: mockAccessRejectJoinRequest,
  },
}));

vi.mock("../../../api/suggestions", () => ({
  suggestionsApi: {
    accept: mockSuggestionsAccept,
    dismiss: mockSuggestionsDismiss,
  },
}));

vi.mock("../../../api/internal-agent", () => ({
  internalAgentApi: {
    confirmAction: mockInternalAgentConfirmAction,
  },
}));

// Mock queryKeys — need cockpit + source-specific keys
vi.mock("../../../lib/queryKeys", () => ({
  queryKeys: {
    cockpit: (companyId: string) => ["cockpit", companyId],
    approvals: {
      list: (companyId: string) => ["approvals", companyId],
    },
    memory: {
      pending: (companyId: string) => ["memory", companyId, "pending"],
      list: (companyId: string) => ["memory", companyId],
    },
    discussions: {
      list: (companyId: string) => ["discussions", companyId],
      detail: (companyId: string, id: string) => ["discussions", companyId, id],
    },
    access: {
      joinRequests: (companyId: string, status: string) => ["access", "join-requests", companyId, status],
    },
    suggestions: {
      pending: (companyId: string) => ["suggestions", companyId, "pending"],
    },
  },
}));

// Mock ToastContext
vi.mock("../../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// ── Import component under test ───────────────────────────────────────────────

import { CockpitApprovalsCard } from "./CockpitApprovalsCard";

// ── Helpers ───────────────────────────────────────────────────────────────────

const COMPANY = "comp-test";

function makeApprovalItem(overrides?: Partial<CockpitApprovalItem>): CockpitApprovalItem {
  return {
    source: "approval",
    id: "appr-1",
    title: "Hire Scout",
    subtitle: "agent hire",
    ...overrides,
  };
}

function renderCard(
  items: CockpitApprovalItem[],
  onOpenFullPage = vi.fn(),
  onAsk = vi.fn(),
  onOpenReference = vi.fn(),
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CockpitApprovalsCard
        items={items}
        companyId={COMPANY}
        onOpenFullPage={onOpenFullPage}
        onOpenReference={onOpenReference}
        onAsk={onAsk}
      />
    </QueryClientProvider>,
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockApprovalsApprove.mockResolvedValue({});
  mockApprovalsReject.mockResolvedValue({});
  mockMemoryApprove.mockResolvedValue({});
  mockMemoryReject.mockResolvedValue({});
  mockMemoryApproveVersion.mockResolvedValue({});
  mockMemoryRejectVersion.mockResolvedValue({});
  mockDiscussionsApproveItems.mockResolvedValue({});
  mockDiscussionsRejectItems.mockResolvedValue({});
  mockAccessApproveJoinRequest.mockResolvedValue({});
  mockAccessRejectJoinRequest.mockResolvedValue({});
  mockSuggestionsAccept.mockResolvedValue({});
  mockSuggestionsDismiss.mockResolvedValue({});
  mockInternalAgentConfirmAction.mockResolvedValue({});
});

// ── Tests: card render ────────────────────────────────────────────────────────

describe("CockpitApprovalsCard — render", () => {
  it("renders null when items is empty", () => {
    const { container } = renderCard([]);
    expect(container.firstChild).toBeNull();
  });

  it("has data-testid='cockpit-card-approvals' when items present", () => {
    renderCard([makeApprovalItem()]);
    expect(screen.getByTestId("cockpit-card-approvals")).toBeInTheDocument();
  });

  it("renders an 'approval' source item with 'Approval' chip", () => {
    renderCard([makeApprovalItem({ source: "approval", title: "Hire Scout" })]);
    expect(screen.getByText("Hire Scout")).toBeInTheDocument();
    expect(screen.getByText("Approval")).toBeInTheDocument();
  });

  it("renders a 'memory' source item with 'Memory' chip", () => {
    renderCard([makeApprovalItem({ source: "memory", id: "mem-1", title: "Use TypeScript", subtitle: "domain" })]);
    expect(screen.getByText("Use TypeScript")).toBeInTheDocument();
    expect(screen.getByText("Memory")).toBeInTheDocument();
  });

  it("renders a 'discussion_item' source item with 'Discussion' chip", () => {
    renderCard([
      makeApprovalItem({
        source: "discussion_item",
        id: "item-1",
        discussionId: "disc-1",
        title: "CI task",
        subtitle: "task",
      }),
    ]);
    expect(screen.getByText("CI task")).toBeInTheDocument();
    expect(screen.getByText("Discussion")).toBeInTheDocument();
  });

  it("renders a 'join_request' source item with 'Join request' chip", () => {
    renderCard([makeApprovalItem({ source: "join_request", id: "jr-1", title: "Alice wants to join" })]);
    expect(screen.getByText("Alice wants to join")).toBeInTheDocument();
    expect(screen.getByText("Join request")).toBeInTheDocument();
  });

  it("renders a 'memory_version' source item with 'Memory edit' chip", () => {
    renderCard([
      makeApprovalItem({ source: "memory_version", id: "mv-item-1", relatedEntityId: "mv-ver-1", title: "Policy v2" }),
    ]);
    expect(screen.getByText("Policy v2")).toBeInTheDocument();
    expect(screen.getByText("Memory edit")).toBeInTheDocument();
  });

  it("renders a 'memory_archive' source item with 'Archive' chip", () => {
    renderCard([
      makeApprovalItem({ source: "memory_archive", id: "ma-item-1", relatedEntityId: "sug-1", title: "Old policy" }),
    ]);
    expect(screen.getByText("Old policy")).toBeInTheDocument();
    expect(screen.getByText("Archive")).toBeInTheDocument();
  });

  it("renders a 'runtime_tool_trust' item with 'Tool trust' chip", () => {
    renderCard([
      makeApprovalItem({ source: "runtime_tool_trust", id: "rt-1", title: "bash", decisionType: "ternary" }),
    ]);
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(screen.getByText("Tool trust")).toBeInTheDocument();
  });

  it("renders all items when multiple present (count lives in CockpitSection trigger, not card header)", () => {
    // Phase 5B: internal header removed; count now lives in the CockpitSection trigger.
    renderCard([makeApprovalItem(), makeApprovalItem({ id: "appr-2", title: "Hire Atlas" })]);
    expect(screen.getByText("Hire Scout")).toBeInTheDocument();
    expect(screen.getByText("Hire Atlas")).toBeInTheDocument();
  });

  it("opens true approvals in Commander and discussion decisions as discussion refs", () => {
    const onOpenReference = vi.fn();
    renderCard(
      [
        makeApprovalItem({ source: "approval", id: "appr-1", title: "Hire Scout" }),
        makeApprovalItem({
          source: "discussion_item",
          id: "item-1",
          discussionId: "disc-1",
          title: "Create launch task",
        }),
      ],
      vi.fn(),
      vi.fn(),
      onOpenReference,
    );

    fireEvent.click(screen.getByRole("button", { name: "Hire Scout" }));
    fireEvent.click(screen.getByRole("button", { name: "Create launch task" }));

    expect(onOpenReference).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: "approval", id: "appr-1" }),
    );
    expect(onOpenReference).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "discussion", id: "disc-1" }),
    );
  });
});

// ── Tests: ternary vs binary button layout ────────────────────────────────────

describe("CockpitApprovalsCard — ternary vs binary", () => {
  it("binary item (approval) renders 2 buttons: Approve + Deny", () => {
    renderCard([makeApprovalItem({ source: "approval" })]);
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /always/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /once/i })).not.toBeInTheDocument();
  });

  it("ternary item (runtime_tool_trust) renders 3 buttons: Always + Once + Deny", () => {
    renderCard([
      makeApprovalItem({ source: "runtime_tool_trust", id: "rt-1", title: "bash", decisionType: "ternary" }),
    ]);
    expect(screen.getByRole("button", { name: /always/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /once/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
    // No "Approve" for ternary rows
    expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
  });
});

// ── Tests: runtime_tool_trust 3-way dispatch ─────────────────────────────────

describe("CockpitApprovalsCard — runtime_tool_trust (ternary)", () => {
  const rtItem: CockpitApprovalItem = {
    source: "runtime_tool_trust",
    id: "rt-confirm-1",
    title: "bash",
    subtitle: "Tool execution approval",
    decisionType: "ternary",
  };

  it("Always → internalAgentApi.confirmAction(companyId, id, 'allow_always')", async () => {
    renderCard([rtItem]);
    fireEvent.click(screen.getByRole("button", { name: /always/i }));
    await waitFor(() =>
      expect(mockInternalAgentConfirmAction).toHaveBeenCalledWith(COMPANY, "rt-confirm-1", "allow_always"),
    );
    expect(mockAccessApproveJoinRequest).not.toHaveBeenCalled();
    expect(mockApprovalsApprove).not.toHaveBeenCalled();
  });

  it("Once → internalAgentApi.confirmAction(companyId, id, 'allow_once')", async () => {
    renderCard([rtItem]);
    fireEvent.click(screen.getByRole("button", { name: /once/i }));
    await waitFor(() =>
      expect(mockInternalAgentConfirmAction).toHaveBeenCalledWith(COMPANY, "rt-confirm-1", "allow_once"),
    );
  });

  it("Deny → internalAgentApi.confirmAction(companyId, id, 'deny')", async () => {
    renderCard([rtItem]);
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    await waitFor(() =>
      expect(mockInternalAgentConfirmAction).toHaveBeenCalledWith(COMPANY, "rt-confirm-1", "deny"),
    );
  });
});

// ── Tests: join_request dispatch ──────────────────────────────────────────────

describe("CockpitApprovalsCard — join_request", () => {
  const jrItem: CockpitApprovalItem = {
    source: "join_request",
    id: "jr-42",
    title: "Bob wants to join",
    subtitle: "User join",
  };

  it("Approve → accessApi.approveJoinRequest(companyId, id)", async () => {
    renderCard([jrItem]);
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(mockAccessApproveJoinRequest).toHaveBeenCalledWith(COMPANY, "jr-42"),
    );
    expect(mockApprovalsApprove).not.toHaveBeenCalled();
  });

  it("Deny → accessApi.rejectJoinRequest(companyId, id)", async () => {
    renderCard([jrItem]);
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    await waitFor(() =>
      expect(mockAccessRejectJoinRequest).toHaveBeenCalledWith(COMPANY, "jr-42"),
    );
    expect(mockApprovalsReject).not.toHaveBeenCalled();
  });
});

// ── Tests: memory_version dispatch ────────────────────────────────────────────

describe("CockpitApprovalsCard — memory_version", () => {
  const mvItem: CockpitApprovalItem = {
    source: "memory_version",
    id: "item-abc",
    relatedEntityId: "ver-xyz",
    title: "Policy v2",
    subtitle: "domain · knowledge (edit)",
  };

  it("Approve → memoryApi.approveVersion(companyId, itemId, versionId)", async () => {
    renderCard([mvItem]);
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(mockMemoryApproveVersion).toHaveBeenCalledWith(COMPANY, "item-abc", "ver-xyz"),
    );
    expect(mockMemoryApprove).not.toHaveBeenCalled();
  });

  it("Deny → memoryApi.rejectVersion(companyId, itemId, versionId)", async () => {
    renderCard([mvItem]);
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    await waitFor(() =>
      expect(mockMemoryRejectVersion).toHaveBeenCalledWith(COMPANY, "item-abc", "ver-xyz"),
    );
    expect(mockMemoryReject).not.toHaveBeenCalled();
  });
});

// ── Tests: memory_archive dispatch ────────────────────────────────────────────

describe("CockpitApprovalsCard — memory_archive", () => {
  const maItem: CockpitApprovalItem = {
    source: "memory_archive",
    id: "mem-item-1",
    relatedEntityId: "sug-999",
    title: "Old strategy doc",
    subtitle: "Suggested for archival",
  };

  it("Approve → suggestionsApi.accept(companyId, suggestionId)", async () => {
    renderCard([maItem]);
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(mockSuggestionsAccept).toHaveBeenCalledWith(COMPANY, "sug-999"),
    );
    expect(mockSuggestionsDismiss).not.toHaveBeenCalled();
  });

  it("Deny → suggestionsApi.dismiss(companyId, suggestionId)", async () => {
    renderCard([maItem]);
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    await waitFor(() =>
      expect(mockSuggestionsDismiss).toHaveBeenCalledWith(COMPANY, "sug-999"),
    );
    expect(mockSuggestionsAccept).not.toHaveBeenCalled();
  });
});

// ── Tests: Approve dispatches correct API per source (HC7) ───────────────────

describe("CockpitApprovalsCard — Approve (HC7)", () => {
  it("source=approval → approvalsApi.approve(id)", async () => {
    renderCard([makeApprovalItem({ source: "approval", id: "appr-1" })]);
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(mockApprovalsApprove).toHaveBeenCalledWith("appr-1"));
    expect(mockMemoryApprove).not.toHaveBeenCalled();
    expect(mockDiscussionsApproveItems).not.toHaveBeenCalled();
  });

  it("source=memory → memoryApi.approve(companyId, id)", async () => {
    renderCard([
      makeApprovalItem({ source: "memory", id: "mem-1", title: "Domain rule", subtitle: "domain" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(mockMemoryApprove).toHaveBeenCalledWith(COMPANY, "mem-1"));
    expect(mockApprovalsApprove).not.toHaveBeenCalled();
    expect(mockDiscussionsApproveItems).not.toHaveBeenCalled();
  });

  it("source=discussion_item → discussionsApi.approveItems with { items:[{itemId, action:'approved'}] } (HC7)", async () => {
    renderCard([
      makeApprovalItem({
        source: "discussion_item",
        id: "item-1",
        discussionId: "disc-1",
        title: "New task",
        subtitle: "task",
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(mockDiscussionsApproveItems).toHaveBeenCalledWith(
        COMPANY,
        "disc-1",
        { items: [{ itemId: "item-1", action: "approved" }] },
      ),
    );
    expect(mockApprovalsApprove).not.toHaveBeenCalled();
    expect(mockMemoryApprove).not.toHaveBeenCalled();
  });
});

// ── Tests: Deny dispatches correct API per source (HC7/HC4) ──────────────────

describe("CockpitApprovalsCard — Deny (HC7/HC4)", () => {
  it("source=approval → approvalsApi.reject(id)", async () => {
    renderCard([makeApprovalItem({ source: "approval", id: "appr-1" })]);
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    await waitFor(() => expect(mockApprovalsReject).toHaveBeenCalledWith("appr-1"));
    expect(mockMemoryReject).not.toHaveBeenCalled();
    expect(mockDiscussionsRejectItems).not.toHaveBeenCalled();
  });

  it("source=memory → memoryApi.reject(companyId, id)", async () => {
    renderCard([
      makeApprovalItem({ source: "memory", id: "mem-1", title: "Domain rule", subtitle: "domain" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    await waitFor(() => expect(mockMemoryReject).toHaveBeenCalledWith(COMPANY, "mem-1"));
    expect(mockApprovalsReject).not.toHaveBeenCalled();
    expect(mockDiscussionsRejectItems).not.toHaveBeenCalled();
  });

  it("source=discussion_item → discussionsApi.rejectItems with [itemId] ARRAY (HC4)", async () => {
    renderCard([
      makeApprovalItem({
        source: "discussion_item",
        id: "item-1",
        discussionId: "disc-1",
        title: "New task",
        subtitle: "task",
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    await waitFor(() =>
      expect(mockDiscussionsRejectItems).toHaveBeenCalledWith(
        COMPANY,
        "disc-1",
        ["item-1"], // HC4: itemIds array, not an object
      ),
    );
    expect(mockApprovalsReject).not.toHaveBeenCalled();
    expect(mockMemoryReject).not.toHaveBeenCalled();
  });
});

// ── Tests: card inactive when empty ──────────────────────────────────────────

describe("CockpitApprovalsCard — empty state", () => {
  it("card absent (null) when approvals=[]", () => {
    const { container } = renderCard([]);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("cockpit-card-approvals")).not.toBeInTheDocument();
  });
});
