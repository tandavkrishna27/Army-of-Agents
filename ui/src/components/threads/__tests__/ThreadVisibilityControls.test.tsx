import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { ThreadVisibilityControls } from "../ThreadVisibilityControls";
import { threadsApi } from "../../../api/threads";
import type { ThreadDetail } from "../../../api/threads";

vi.mock("../../../api/threads", () => ({
  threadsApi: {
    setVisibility: vi.fn().mockResolvedValue({}),
    generateShareToken: vi.fn().mockResolvedValue({ token: "tok-fresh" }),
    revokeShareToken: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("../../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

function makeThread(overrides: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    id: "thread-1",
    title: "Improve onboarding flow",
    status: "active",
    scopeType: null,
    scopeId: null,
    scopeName: null,
    tags: [],
    entryCount: 2,
    pendingItemCount: 1,
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    entries: [],
    phase: "discuss",
    visibility: "company",
    ownerUserId: null,
    originSource: "mcp",
    intent: ["improve ux", "reduce churn"],
    goalId: null,
    autonomyLevel: 1,
    summaryText: null,
    summaryNext: null,
    crewPaused: false,
    subtype: "normal",
    shareToken: null,
    participants: [],
    allowMemoryExtraction: true,
    ...overrides,
  };
}

describe("ThreadVisibilityControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 3-option visibility selector ────────────────────────────────────────

  it("renders visibility selector with the current value", () => {
    const thread = makeThread({ visibility: "department" });
    renderWithProviders(
      <ThreadVisibilityControls thread={thread} companyId="comp-1" />,
    );
    const selector = screen.getByTestId("visibility-selector");
    expect(selector).toBeInTheDocument();
    expect(selector).toHaveTextContent(/department/i);
  });

  it("calls threadsApi.setVisibility when a new option is chosen", async () => {
    const thread = makeThread({ visibility: "company" });
    const user = userEvent.setup();
    renderWithProviders(
      <ThreadVisibilityControls thread={thread} companyId="comp-1" />,
    );
    await user.click(screen.getByTestId("visibility-selector"));
    const option = await screen.findByTestId("visibility-option-private");
    await user.click(option);
    await waitFor(() => {
      expect(threadsApi.setVisibility).toHaveBeenCalledWith(
        "comp-1",
        "thread-1",
        "private",
      );
    });
  });

  it("renders all three visibility options in the menu", async () => {
    const thread = makeThread();
    const user = userEvent.setup();
    renderWithProviders(
      <ThreadVisibilityControls thread={thread} companyId="comp-1" />,
    );
    await user.click(screen.getByTestId("visibility-selector"));
    expect(await screen.findByTestId("visibility-option-private")).toBeInTheDocument();
    expect(screen.getByTestId("visibility-option-department")).toBeInTheDocument();
    expect(screen.getByTestId("visibility-option-company")).toBeInTheDocument();
  });

  it("does not re-fire setVisibility when the active option is re-selected", async () => {
    const thread = makeThread({ visibility: "company" });
    const user = userEvent.setup();
    renderWithProviders(
      <ThreadVisibilityControls thread={thread} companyId="comp-1" />,
    );
    await user.click(screen.getByTestId("visibility-selector"));
    const option = await screen.findByTestId("visibility-option-company");
    await user.click(option);
    // Radix calls onValueChange only when the value actually changes, and the
    // handler short-circuits on no-op selections.
    expect(threadsApi.setVisibility).not.toHaveBeenCalled();
  });

  // ── Share link block ────────────────────────────────────────────────────

  it("renders the share-link block", () => {
    const thread = makeThread();
    renderWithProviders(
      <ThreadVisibilityControls thread={thread} companyId="comp-1" />,
    );
    expect(screen.getByTestId("share-link-block")).toBeInTheDocument();
  });

  it("renders 'Generate share link' when shareToken is null", () => {
    const thread = makeThread({ shareToken: null });
    renderWithProviders(
      <ThreadVisibilityControls thread={thread} companyId="comp-1" />,
    );
    expect(screen.getByTestId("generate-share-token")).toBeInTheDocument();
    expect(screen.queryByTestId("share-link-url")).not.toBeInTheDocument();
  });

  it("calls threadsApi.generateShareToken when 'Generate share link' is clicked", async () => {
    const thread = makeThread({ shareToken: null });
    const user = userEvent.setup();
    renderWithProviders(
      <ThreadVisibilityControls thread={thread} companyId="comp-1" />,
    );
    await user.click(screen.getByTestId("generate-share-token"));
    await waitFor(() => {
      expect(threadsApi.generateShareToken).toHaveBeenCalledWith(
        "comp-1",
        "thread-1",
      );
    });
  });

  it("renders share URL, copy, and revoke when shareToken is set", () => {
    const thread = makeThread({ shareToken: "tok-abc" });
    renderWithProviders(
      <ThreadVisibilityControls thread={thread} companyId="comp-1" />,
    );
    const url = screen.getByTestId("share-link-url");
    expect(url).toBeInTheDocument();
    expect(url.textContent).toContain("/discussions/thread-1?token=tok-abc");
    expect(screen.getByTestId("copy-share-token")).toBeInTheDocument();
    expect(screen.getByTestId("revoke-share-token")).toBeInTheDocument();
  });

  it("calls threadsApi.revokeShareToken when 'Revoke' is clicked", async () => {
    const thread = makeThread({ shareToken: "tok-abc" });
    const user = userEvent.setup();
    renderWithProviders(
      <ThreadVisibilityControls thread={thread} companyId="comp-1" />,
    );
    await user.click(screen.getByTestId("revoke-share-token"));
    await waitFor(() => {
      expect(threadsApi.revokeShareToken).toHaveBeenCalledWith(
        "comp-1",
        "thread-1",
      );
    });
  });
});
