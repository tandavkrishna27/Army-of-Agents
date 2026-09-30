import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, mockCompanyContext } from "./test-utils";
import { AccessRequired } from "../pages/AccessRequired";

// AccessRequired renders through the app router's useNavigate (@/lib/router),
// which reads company context. Mock the underlying react-router-dom navigate
// (a spy) and the company context so the surface renders in isolation.
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

describe("AccessRequired", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.companies = [];
    mockCompanyContext.selectedCompany = null;
    mockCompanyContext.selectedCompanyId = null;
  });

  it("renders the access-required message", () => {
    renderWithProviders(<AccessRequired />);
    expect(screen.getByText("You don't have access to this")).toBeInTheDocument();
  });

  it("names the requested company prefix when it is known", () => {
    renderWithProviders(<AccessRequired requestedPrefix="ACME" />);
    expect(screen.getByText(/ACME/)).toBeInTheDocument();
  });

  it("falls back to a generic workspace label when no prefix is known", () => {
    renderWithProviders(<AccessRequired />);
    expect(screen.getByText(/this workspace/i)).toBeInTheDocument();
  });

  it("does NOT render a request-access affordance (v1)", () => {
    renderWithProviders(<AccessRequired requestedPrefix="ACME" />);
    expect(screen.queryByRole("button", { name: /request access/i })).toBeNull();
  });

  it("'Back to your companies' navigates to the lobby (/)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AccessRequired requestedPrefix="ACME" />);
    await user.click(screen.getByRole("button", { name: /back to your companies/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/", undefined);
  });
});
