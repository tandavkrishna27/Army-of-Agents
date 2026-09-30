import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext, makeCompany } from "./test-utils";
import { Issues } from "../pages/Issues";
import { ApiError } from "../api/client";

// Piece 3 (adopted): the Tasks page's PRIMARY company-scoped query
// (issuesApi.list) 403-ing means this workspace is off-limits (e.g. membership
// revoked) — render AccessRequired instead of the list's generic error. A
// non-403 error keeps the page's normal inline error state.

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: vi.fn(),
    setSubtitle: vi.fn(),
    setEntityColor: vi.fn(),
  }),
}));

const mockIssuesList = vi.fn();
vi.mock("../api/issues", () => ({
  issuesApi: {
    list: (...args: unknown[]) => mockIssuesList(...args),
    markRead: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../api/cockpit", () => ({
  cockpitApi: { listTasks: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null }) },
}));
vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: vi.fn().mockResolvedValue([]) },
}));

// The list + slide-over are heavy; stub. The list stub surfaces whether it was
// handed an error prop (the page's normal error path).
vi.mock("../components/IssuesList", () => ({
  IssuesList: ({ error }: { error: unknown }) =>
    error ? <div data-testid="issues-list-error" /> : <div data-testid="issues-list" />,
}));
vi.mock("../components/TaskSlideOver", () => ({
  TaskSlideOver: () => null,
}));

describe("Issues (Tasks) company-scoped 403 handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.companies = [makeCompany({ id: "comp-1", issuePrefix: "ACME" })];
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockCompanyContext.selectedCompany = makeCompany({ id: "comp-1", issuePrefix: "ACME" });
    mockCompanyContext.loading = false;
  });

  it("renders AccessRequired when the primary tasks query 403s", async () => {
    mockIssuesList.mockRejectedValue(new ApiError("Forbidden", 403, { error: "Forbidden" }));

    renderWithProviders(<Issues />, { initialEntries: ["/ACME/issues"] });

    expect(await screen.findByText("You don't have access to this")).toBeInTheDocument();
    // The page body short-circuits — no heading, no list.
    expect(screen.queryByRole("heading", { name: /tasks/i })).toBeNull();
    expect(screen.queryByTestId("issues-list")).toBeNull();
    expect(screen.queryByTestId("issues-list-error")).toBeNull();
  });

  it("keeps the normal inline error state for a non-403 error", async () => {
    mockIssuesList.mockRejectedValue(new ApiError("Boom", 500, { error: "Boom" }));

    renderWithProviders(<Issues />, { initialEntries: ["/ACME/issues"] });

    // Normal page renders and the list receives the error (its own error UI).
    expect(await screen.findByRole("heading", { name: /tasks/i })).toBeInTheDocument();
    expect(await screen.findByTestId("issues-list-error")).toBeInTheDocument();
    expect(screen.queryByText("You don't have access to this")).toBeNull();
  });
});
