import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext } from "./test-utils";
import { AccessRequiredBoundary } from "../pages/AccessRequired";
import { ApiError, isForbidden } from "../api/client";

// Piece 3: a 403 from a company-scoped query should render the friendly
// AccessRequired surface (mirroring InstanceSettingsPage's 403 panel), NOT the
// generic error UI. AccessRequiredBoundary is the shared render-branch keyed on
// isForbidden.

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

const forbidden = () => new ApiError("Forbidden", 403, { error: "Forbidden" });

describe("isForbidden", () => {
  it("is true only for an ApiError with status 403", () => {
    expect(isForbidden(forbidden())).toBe(true);
    expect(isForbidden(new ApiError("Not found", 404, null))).toBe(false);
    expect(isForbidden(new ApiError("Boom", 500, null))).toBe(false);
    expect(isForbidden(new Error("plain"))).toBe(false);
    expect(isForbidden(null)).toBe(false);
    expect(isForbidden(undefined)).toBe(false);
  });
});

describe("AccessRequiredBoundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.companies = [];
    mockCompanyContext.selectedCompany = null;
    mockCompanyContext.selectedCompanyId = null;
  });

  it("renders AccessRequired for a 403 query error (not the page content)", () => {
    renderWithProviders(
      <AccessRequiredBoundary error={forbidden()}>
        <div data-testid="page-content">Company-scoped content</div>
      </AccessRequiredBoundary>,
    );
    expect(screen.getByText("You don't have access to this")).toBeInTheDocument();
    expect(screen.queryByTestId("page-content")).toBeNull();
  });

  it("renders children unchanged when there is no error", () => {
    renderWithProviders(
      <AccessRequiredBoundary error={null}>
        <div data-testid="page-content">Company-scoped content</div>
      </AccessRequiredBoundary>,
    );
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    expect(screen.queryByText("You don't have access to this")).toBeNull();
  });

  it("passes non-403 errors through to children (handled by existing error UI)", () => {
    renderWithProviders(
      <AccessRequiredBoundary error={new ApiError("Boom", 500, null)}>
        <div data-testid="page-content">Company-scoped content</div>
      </AccessRequiredBoundary>,
    );
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    expect(screen.queryByText("You don't have access to this")).toBeNull();
  });

  it("forwards className to the AccessRequired surface on a 403", () => {
    const { container } = renderWithProviders(
      <AccessRequiredBoundary error={forbidden()} className="embedded-access">
        <div data-testid="page-content">Company-scoped content</div>
      </AccessRequiredBoundary>,
    );
    expect(container.querySelector(".embedded-access")).toBeTruthy();
  });
});
