import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { Company } from "@armyofagents/shared";
import { companiesApi } from "@/api/companies";
import { CompanyProvider } from "@/context/CompanyContext";
import {
  AOA_DEFAULT_CREW_MARKETPLACE_ROUTE,
  AOA_DEFAULT_CREW_ROSTER_PATH,
} from "@/lib/marketplace-constants";
import { makeCompany } from "@/__tests__/test-utils";
import { DefaultCrewRosterRedirect } from "../DefaultCrewRosterRedirect";

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

function renderRedirect() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CompanyProvider>
        <MemoryRouter
          initialEntries={[`/${AOA_DEFAULT_CREW_MARKETPLACE_ROUTE}`]}
        >
          <Routes>
            <Route
              path={AOA_DEFAULT_CREW_MARKETPLACE_ROUTE}
              element={<DefaultCrewRosterRedirect />}
            />
            <Route path="/:companyPrefix/team" element={<LocationProbe />} />
            <Route path="/onboarding" element={<div>Onboarding</div>} />
          </Routes>
        </MemoryRouter>
      </CompanyProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("DefaultCrewRosterRedirect", () => {
  it("waits for delayed company bootstrap and honors the persisted selection", async () => {
    let resolveCompanies!: (companies: Company[]) => void;
    vi.spyOn(companiesApi, "list").mockReturnValue(
      new Promise<Company[]>((resolve) => {
        resolveCompanies = resolve;
      })
    );
    localStorage.setItem("aoa.selectedCompanyId", "company-selected");

    renderRedirect();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByTestId("location")).not.toBeInTheDocument();

    await act(async () => {
      resolveCompanies([
        makeCompany({ id: "company-first", issuePrefix: "FIRST" }),
        makeCompany({ id: "company-selected", issuePrefix: "SELECTED" }),
      ]);
    });

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/SELECTED${AOA_DEFAULT_CREW_ROSTER_PATH}`
      )
    );
  });

  it("uses the first company when no selection was persisted", async () => {
    vi.spyOn(companiesApi, "list").mockResolvedValue([
      makeCompany({ id: "company-first", issuePrefix: "FIRST" }),
      makeCompany({ id: "company-second", issuePrefix: "SECOND" }),
    ]);

    renderRedirect();

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/FIRST${AOA_DEFAULT_CREW_ROSTER_PATH}`
      )
    );
  });

  it("surfaces a company-query failure instead of redirecting to onboarding", async () => {
    vi.spyOn(companiesApi, "list").mockRejectedValue(
      new Error("companies unavailable"),
    );

    renderRedirect();

    expect(
      await screen.findByText(
        "Failed to load companies: companies unavailable",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Onboarding")).not.toBeInTheDocument();
    expect(screen.queryByTestId("location")).not.toBeInTheDocument();
  });
});
