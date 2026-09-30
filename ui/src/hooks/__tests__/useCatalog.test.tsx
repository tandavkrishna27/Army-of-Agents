import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useCatalog } from "../useCatalog";
import { marketplaceApi } from "@/api/marketplace";
import { FULL_CATALOG } from "@/__tests__/__fixtures__/marketplace-catalog";

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>(
    "@/api/marketplace",
  );
  return { ...actual, marketplaceApi: { getCatalog: vi.fn() } };
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches catalog and exposes data + isLoading + error", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);

    const { result } = renderHook(() => useCatalog(), { wrapper });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual(FULL_CATALOG);
    expect(result.current.error).toBeNull();
    expect(marketplaceApi.getCatalog).toHaveBeenCalledTimes(1);
  });

  it("surfaces error when fetch fails", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockRejectedValueOnce(
      new Error("503 Catalog not yet synced"),
    );

    const { result } = renderHook(() => useCatalog(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect((result.current.error as Error).message).toMatch(
      /Catalog not yet synced/,
    );
    expect(result.current.data).toBeUndefined();
  });
});
