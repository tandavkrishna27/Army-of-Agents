import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../__tests__/test-utils";
import { Companies } from "../Companies";

const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [],
    selectedCompanyId: null,
    setSelectedCompanyId: vi.fn(),
    loading: false,
    error: null,
  }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../../api/companies", () => ({
  companiesApi: {
    stats: vi.fn().mockResolvedValue({}),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));

describe("Companies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the explicit new-organization onboarding path", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Companies />);

    await user.click(screen.getByRole("button", { name: /new company/i }));

    expect(mockNavigate).toHaveBeenCalledWith("/onboarding?new=1");
  });
});
