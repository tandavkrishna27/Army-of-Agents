/**
 * ApprovalDetailCore — prop-id + embedded chrome/route gating (D3, Inbox Hub).
 *
 * Verifies the D3 refactor that lets the approval body be hosted inside a hub
 * tab:
 *   1. `<ApprovalDetailCore approvalId="a1" embedded onOpenTab={spy}/>` renders
 *      the payload + approve/reject by PROP id (no useParams).
 *   2. When `embedded`, the 4 route couplings are neutralized:
 *        - setBreadcrumbs is NOT called (host owns breadcrumbs)
 *        - setSelectedCompanyId route-sync is NOT called
 *        - navigate is NOT called on approve (refetch instead)
 *        - linked-task / resolved CTA render as buttons calling onOpenTab,
 *          not <Link> route nav.
 *   3. Route mode (`embedded` false) STILL sets breadcrumbs + uses navigate on
 *      approve, and renders linked tasks as <Link>s.
 *
 * Mirrors the useParams/context mock pattern from ThreadDetail.embedded.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { ApprovalDetailCore } from "../ApprovalDetailCore";
import { taskTab } from "../../hub/hubViewerModel";

// --- Approval + linked-issue fixtures. Only the fields the render path touches
//     need to be present; the rest are permissive. ---
function makeApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    companyId: "comp-1",
    type: "hire_agent",
    status: "pending",
    payload: { agentId: "agent-9" },
    requestedByAgentId: null,
    decisionNote: null,
    ...overrides,
  };
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "TC-1",
    title: "Do the thing",
    ...overrides,
  };
}

// --- API mocks (Proxy so every un-stubbed method is a resolved no-op) ---
const approvalGetMock = vi.fn();
const approvalApproveMock = vi.fn();
const approvalRejectMock = vi.fn();
const approvalIssuesMock = vi.fn();
const approvalCommentsMock = vi.fn();
vi.mock("../../../api/approvals", () => ({
  approvalsApi: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "get") return approvalGetMock;
        if (prop === "approve") return approvalApproveMock;
        if (prop === "reject") return approvalRejectMock;
        if (prop === "listIssues") return approvalIssuesMock;
        if (prop === "listComments") return approvalCommentsMock;
        return vi.fn().mockResolvedValue([]);
      },
    },
  ),
}));

const agentsListMock = vi.fn();
vi.mock("../../../api/agents", () => ({
  agentsApi: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "list") return agentsListMock;
        return vi.fn().mockResolvedValue({ ok: true });
      },
    },
  ),
}));

// `useParams` returns NOTHING — proves the core reads the prop id, not the route.
const useParamsMock = vi.fn(() => ({}) as Record<string, string | undefined>);
const navigateSpy = vi.fn();
vi.mock("@/lib/router", async () => {
  const actual = (await vi.importActual("react-router-dom")) as any;
  return {
    ...actual,
    useParams: () => useParamsMock(),
    useNavigate: () => navigateSpy,
    Link: actual.Link,
  };
});

const setSelectedCompanyIdSpy = vi.fn();
vi.mock("../../../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "comp-1",
    setSelectedCompanyId: setSelectedCompanyIdSpy,
  }),
}));

const setBreadcrumbsSpy = vi.fn();
vi.mock("../../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsSpy }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useParamsMock.mockReturnValue({});
  approvalGetMock.mockResolvedValue(makeApproval());
  approvalApproveMock.mockResolvedValue(makeApproval({ status: "approved" }));
  approvalRejectMock.mockResolvedValue(makeApproval({ status: "rejected" }));
  approvalIssuesMock.mockResolvedValue([]);
  approvalCommentsMock.mockResolvedValue([]);
  agentsListMock.mockResolvedValue([]);
});

describe("ApprovalDetailCore — embedded (hub tab)", () => {
  it("renders the payload + approve/reject for the prop id without reading useParams", async () => {
    renderWithProviders(
      <ApprovalDetailCore approvalId="a1" embedded onOpenTab={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /^reject$/i })).toBeInTheDocument();
    // The approval header renders the id.
    expect(screen.getByText("a1")).toBeInTheDocument();
    // detail() was called with the PROP id.
    expect(approvalGetMock).toHaveBeenCalledWith("a1");
  });

  it("does NOT set breadcrumbs or company route-sync when embedded", async () => {
    // approval.companyId (comp-2) differs from selected (comp-1) to prove the
    // route-sync effect is gated, not just a no-op because ids match.
    approvalGetMock.mockResolvedValue(makeApproval({ companyId: "comp-2" }));

    renderWithProviders(
      <ApprovalDetailCore approvalId="a1" embedded onOpenTab={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
    });

    expect(setBreadcrumbsSpy).not.toHaveBeenCalled();
    expect(setSelectedCompanyIdSpy).not.toHaveBeenCalled();
  });

  it("refetches instead of navigating on approve when embedded", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ApprovalDetailCore approvalId="a1" embedded onOpenTab={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /^approve$/i }));

    await waitFor(() => {
      expect(approvalApproveMock).toHaveBeenCalledWith("a1");
    });
    // Embedded: never navigates — the hub item reconciles + the query refetches.
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("opens a hub task tab (not route nav) when a linked task is clicked", async () => {
    const user = userEvent.setup();
    const onOpenTab = vi.fn();
    approvalIssuesMock.mockResolvedValue([makeIssue({ id: "issue-1", title: "Do the thing" })]);

    renderWithProviders(
      <ApprovalDetailCore approvalId="a1" embedded onOpenTab={onOpenTab} />,
    );

    const linked = await screen.findByRole("button", { name: /do the thing/i });
    await user.click(linked);

    expect(onOpenTab).toHaveBeenCalledTimes(1);
    expect(onOpenTab).toHaveBeenCalledWith(taskTab("issue-1", "Do the thing"));
    // No <Link> route nav for the linked task in embedded mode.
    expect(screen.queryByRole("link", { name: /do the thing/i })).toBeNull();
  });
});

describe("ApprovalDetailCore — route mode", () => {
  it("sets breadcrumbs and navigates on approve", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ApprovalDetailCore approvalId="a1" />);

    // Wait for the approval to resolve out of the loading skeleton.
    const approveBtn = await screen.findByRole("button", { name: /^approve$/i });
    expect(setBreadcrumbsSpy).toHaveBeenCalled();

    await user.click(approveBtn);

    await waitFor(() => {
      expect(approvalApproveMock).toHaveBeenCalledWith("a1");
    });
    expect(navigateSpy).toHaveBeenCalledWith(
      "/approvals/a1?resolved=approved",
      { replace: true },
    );
  });

  it("renders linked tasks as <Link>s (route nav) when not embedded", async () => {
    approvalIssuesMock.mockResolvedValue([makeIssue({ id: "issue-1", title: "Do the thing" })]);

    renderWithProviders(<ApprovalDetailCore approvalId="a1" />);

    const link = await screen.findByRole("link", { name: /do the thing/i });
    expect(link).toHaveAttribute("href", expect.stringContaining("/issues/TC-1"));
  });
});
