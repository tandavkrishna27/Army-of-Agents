import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useOperationStatus } from "../useOperationStatus";
import { marketplaceApi } from "@/api/marketplace";
import { ApiError } from "@/api/client";

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>(
    "@/api/marketplace",
  );
  return {
    ...actual,
    marketplaceApi: { ...actual.marketplaceApi, getOperation: vi.fn() },
  };
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useOperationStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns operation when terminal status (success)", async () => {
    vi.mocked(marketplaceApi.getOperation).mockResolvedValueOnce({
      id: "op-1",
      status: "success",
      companyId: "c1",
      catalogItemId: "x",
      itemType: "skill",
      targetDepartmentId: null,
      resultEntityId: "skill-1",
      errorMessage: null,
      cascadeResults: null,
      startedAt: "",
      completedAt: "",
      createdAt: "",
    });
    const { result } = renderHook(
      () => useOperationStatus({ companyId: "c1", operationId: "op-1" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data?.status).toBe("success"));
  });

  it("does not fetch when operationId is null", () => {
    const { result } = renderHook(
      () => useOperationStatus({ companyId: "c1", operationId: null }),
      { wrapper },
    );
    expect(result.current.fetchStatus).toBe("idle");
    expect(marketplaceApi.getOperation).not.toHaveBeenCalled();
  });

  it("turns the canonical cloud 503 into a terminal blocked operation", async () => {
    vi.mocked(marketplaceApi.getOperation).mockRejectedValueOnce(
      new ApiError(
        "Plugin execution is blocked on AoA Cloud until isolated workers are available",
        503,
        {
          error:
            "Plugin execution is blocked on AoA Cloud until isolated workers are available",
          code: "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
          docs: "/docs/guides/cloud-plugin-execution",
        },
      ),
    );
    const { result } = renderHook(
      () => useOperationStatus({ companyId: "c1", operationId: "op-1" }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data?.status).toBe("failure"));
    expect(result.current.data?.errorCode).toBe(
      "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
    );
    expect(result.current.error).toBeNull();
  });
});
