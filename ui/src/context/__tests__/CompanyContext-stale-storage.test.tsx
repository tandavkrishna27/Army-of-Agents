import { describe, expect, it } from "vitest";
import { resolveBootstrapCompanySelection, shouldClearStoredCompanySelection } from "../CompanyContext.js";

describe("resolveBootstrapCompanySelection", () => {
  const c1 = { id: "c1", name: "Company 1" } as any;
  const c2 = { id: "c2", name: "Company 2" } as any;

  it("returns null when no companies", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [],
      sidebarCompanies: [],
      selectedCompanyId: "c1",
      storedCompanyId: "c1",
    })).toBeNull();
  });

  it("prefers selectedCompanyId when valid", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [c1, c2],
      sidebarCompanies: [],
      selectedCompanyId: "c2",
      storedCompanyId: "c1",
    })).toBe("c2");
  });

  it("falls back to storedCompanyId when selectedCompanyId invalid", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [c1, c2],
      sidebarCompanies: [],
      selectedCompanyId: "c_stale",
      storedCompanyId: "c1",
    })).toBe("c1");
  });

  it("falls back to first sidebar company when neither matches", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [c1, c2],
      sidebarCompanies: [c2],
      selectedCompanyId: null,
      storedCompanyId: "c_stale",
    })).toBe("c2");
  });

  it("falls back to first company when sidebar empty + neither matches", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [c1, c2],
      sidebarCompanies: [],
      selectedCompanyId: null,
      storedCompanyId: "c_stale",
    })).toBe("c1");
  });
});

describe("shouldClearStoredCompanySelection", () => {
  it("returns true when not loading + not unauthorized + zero companies", () => {
    expect(shouldClearStoredCompanySelection({
      companies: [],
      isLoading: false,
      unauthorized: false,
    })).toBe(true);
  });

  it("returns false during loading", () => {
    expect(shouldClearStoredCompanySelection({
      companies: [],
      isLoading: true,
      unauthorized: false,
    })).toBe(false);
  });

  it("returns false when unauthorized", () => {
    expect(shouldClearStoredCompanySelection({
      companies: [],
      isLoading: false,
      unauthorized: true,
    })).toBe(false);
  });

  it("returns false when companies exist", () => {
    expect(shouldClearStoredCompanySelection({
      companies: [{ id: "c1" } as any],
      isLoading: false,
      unauthorized: false,
    })).toBe(false);
  });
});
