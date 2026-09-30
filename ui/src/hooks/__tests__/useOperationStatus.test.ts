import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { useOperationStatus } from "../useOperationStatus";
import * as marketplaceApi from "@/api/marketplace";

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

describe("useOperationStatus — startedAfter guard", () => {
  it("returns stale_operation error when op createdAt is before startedAfter", async () => {
    const staleOp = {
      id: "op-1",
      companyId: "c-1",
      status: "failure" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      catalogItemId: "plugin:aoa-curated/aoa-plugin-slack",
      itemType: "plugin" as const,
      targetDepartmentId: null,
      resultEntityId: null,
      errorMessage: null,
      cascadeResults: null,
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: null,
    };
    vi.spyOn(marketplaceApi.marketplaceApi, "getOperation").mockResolvedValue(staleOp);

    const startedAfter = new Date("2026-05-01T00:00:00Z"); // after staleOp.createdAt

    const { result } = renderHook(
      () =>
        useOperationStatus({
          companyId: "c-1",
          operationId: "op-1",
          startedAfter,
        }),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.status).toBe("failure");
    expect(result.current.data?.errorMessage).toBe("stale_operation");
  });

  it("returns real status when op createdAt is after startedAfter", async () => {
    const freshOp = {
      id: "op-2",
      companyId: "c-1",
      status: "success" as const,
      createdAt: "2026-05-06T10:00:00Z",
      updatedAt: "2026-05-06T10:00:01Z",
      catalogItemId: "plugin:aoa-curated/aoa-plugin-slack",
      itemType: "plugin" as const,
      targetDepartmentId: null,
      resultEntityId: null,
      errorMessage: null,
      cascadeResults: null,
      startedAt: "2026-05-06T10:00:00Z",
      completedAt: "2026-05-06T10:00:01Z",
    };
    vi.spyOn(marketplaceApi.marketplaceApi, "getOperation").mockResolvedValue(freshOp);

    const startedAfter = new Date("2026-05-06T09:00:00Z"); // before freshOp.createdAt

    const { result } = renderHook(
      () =>
        useOperationStatus({
          companyId: "c-1",
          operationId: "op-2",
          startedAfter,
        }),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.status).toBe("success");
    expect(result.current.data?.errorMessage).toBeNull();
  });
});
