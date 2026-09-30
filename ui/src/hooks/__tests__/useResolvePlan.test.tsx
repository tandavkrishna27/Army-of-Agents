import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useResolvePlan } from "../useResolvePlan";
import { marketplaceApi } from "@/api/marketplace";

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>(
    "@/api/marketplace",
  );
  return {
    ...actual,
    marketplaceApi: { ...actual.marketplaceApi, resolvePlan: vi.fn() },
  };
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const FAKE_PLAN = {
  rootItem: {
    id: "skill:test/foo",
    name: "Foo",
    type: "skill",
    version: "1.0.0",
  },
  steps: [
    {
      catalogItemId: "skill:test/foo",
      itemType: "skill" as const,
      name: "Foo",
      version: "1.0.0",
      action: "install-new" as const,
    },
  ],
  conflicts: [],
};

describe("useResolvePlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches plan when companyId + catalogItemId both present", async () => {
    vi.mocked(marketplaceApi.resolvePlan).mockResolvedValueOnce(FAKE_PLAN);
    const { result } = renderHook(
      () =>
        useResolvePlan({ companyId: "c1", catalogItemId: "skill:test/foo" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual(FAKE_PLAN);
    expect(marketplaceApi.resolvePlan).toHaveBeenCalledWith(
      "c1",
      "skill:test/foo",
    );
  });

  it("does not fetch when companyId is null", () => {
    const { result } = renderHook(
      () =>
        useResolvePlan({ companyId: null, catalogItemId: "skill:test/foo" }),
      { wrapper },
    );
    expect(result.current.fetchStatus).toBe("idle");
    expect(marketplaceApi.resolvePlan).not.toHaveBeenCalled();
  });

  it("surfaces error from API", async () => {
    vi.mocked(marketplaceApi.resolvePlan).mockRejectedValueOnce(
      new Error("404 Catalog item not found"),
    );
    const { result } = renderHook(
      () =>
        useResolvePlan({ companyId: "c1", catalogItemId: "skill:nonexistent" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
  });
});
