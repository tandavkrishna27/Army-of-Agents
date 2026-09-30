import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MarketplacePackage } from "@armyofagents/shared";
import { usePackages, packagesQueryKey } from "../usePackages";

vi.mock("@/api/marketplace", () => ({
  marketplaceApi: {
    getPackages: vi.fn(),
  },
}));

import { marketplaceApi } from "@/api/marketplace";

const SAMPLE: MarketplacePackage = {
  id: "garrytan/gstack",
  name: "gstack",
  sourceUrl: "https://github.com/garrytan/gstack",
  memberItemIds: ["skill:a", "skill:b"],
  count: 2,
  verified: true,
  explicit: false,
};

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("usePackages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls marketplaceApi.getPackages and returns the data", async () => {
    vi.mocked(marketplaceApi.getPackages).mockResolvedValue([SAMPLE]);
    const { result } = renderHook(() => usePackages(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([SAMPLE]);
    expect(marketplaceApi.getPackages).toHaveBeenCalledTimes(1);
  });

  it("propagates errors from the API", async () => {
    vi.mocked(marketplaceApi.getPackages).mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => usePackages(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("boom");
  });

  it("exports packagesQueryKey as a tuple matching the queryKey used by the hook", () => {
    expect(packagesQueryKey).toEqual(["marketplace", "packages"]);
  });
});
