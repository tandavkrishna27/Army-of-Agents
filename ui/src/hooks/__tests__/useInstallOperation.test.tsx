import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useInstallOperation } from "../useInstallOperation";
import { marketplaceApi } from "@/api/marketplace";

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>(
    "@/api/marketplace",
  );
  return {
    ...actual,
    marketplaceApi: { ...actual.marketplaceApi, install: vi.fn() },
  };
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useInstallOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POSTs install + returns operationId", async () => {
    vi.mocked(marketplaceApi.install).mockResolvedValueOnce({
      operationId: "op-1",
      status: "pending",
    });
    const { result } = renderHook(
      () => useInstallOperation({ companyId: "c1" }),
      { wrapper },
    );
    await act(async () => {
      const r = await result.current.mutateAsync({
        catalogItemId: "skill:test/foo",
        targetDepartmentId: "dept-1",
      });
      expect(r.operationId).toBe("op-1");
    });
    expect(marketplaceApi.install).toHaveBeenCalledWith("c1", {
      catalogItemId: "skill:test/foo",
      targetDepartmentId: "dept-1",
    });
  });

  it("surfaces error on install failure", async () => {
    vi.mocked(marketplaceApi.install).mockRejectedValueOnce(
      new Error("400 Bad Request"),
    );
    const { result } = renderHook(
      () => useInstallOperation({ companyId: "c1" }),
      { wrapper },
    );
    await act(async () => {
      try {
        await result.current.mutateAsync({ catalogItemId: "skill:test/foo" });
      } catch {
        // expected
      }
    });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
  });
});
