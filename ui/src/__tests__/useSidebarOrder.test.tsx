import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiGet = vi.fn();
const apiPatch = vi.fn();
const apiReset = vi.fn();

vi.mock("@/api/sidebar-preferences", () => ({
  sidebarPreferencesApi: {
    get: (...args: unknown[]) => apiGet(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    reset: (...args: unknown[]) => apiReset(...args),
  },
}));

import { useSidebarOrder } from "../hooks/useSidebarOrder";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const DEPT_1 = "22222222-2222-2222-2222-222222222222";
const DEPT_2 = "33333333-3333-3333-3333-333333333333";
const PROJ_1 = "44444444-4444-4444-4444-444444444444";
const TEST_DEBOUNCE_MS = 400;

function wrapperWithQueryClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("useSidebarOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not call the API when companyId is missing", async () => {
    const { result } = renderHook(() => useSidebarOrder(null), {
      wrapper: wrapperWithQueryClient(),
    });
    expect(apiGet).not.toHaveBeenCalled();
    expect(result.current.departmentOrder).toEqual([]);
    expect(result.current.projectOrder).toEqual([]);
  });

  it("loads preferences and exposes per-type orders", async () => {
    apiGet.mockResolvedValue({
      departmentOrder: [DEPT_1, DEPT_2],
      projectOrder: [PROJ_1],
      updatedAt: "2026-04-20T00:00:00.000Z",
    });

    const { result } = renderHook(() => useSidebarOrder(COMPANY_A), {
      wrapper: wrapperWithQueryClient(),
    });

    await waitFor(() => {
      expect(result.current.departmentOrder).toEqual([DEPT_1, DEPT_2]);
      expect(result.current.projectOrder).toEqual([PROJ_1]);
    });
    expect(result.current.orderFor("department")).toEqual([DEPT_1, DEPT_2]);
    expect(result.current.orderFor("project")).toEqual([PROJ_1]);
  });

  it("setOrder is optimistic and debounces the PATCH", async () => {
    apiGet.mockResolvedValue({ departmentOrder: [], projectOrder: [], updatedAt: null });
    apiPatch.mockResolvedValue({
      departmentOrder: [DEPT_2, DEPT_1],
      projectOrder: [],
      updatedAt: "2026-04-20T00:00:00.000Z",
    });

    const { result } = renderHook(
      () => useSidebarOrder(COMPANY_A, { debounceMs: TEST_DEBOUNCE_MS }),
      { wrapper: wrapperWithQueryClient() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    act(() => {
      result.current.setOrder("department", [DEPT_2, DEPT_1]);
    });

    // Optimistic update reflects well before the debounce fires.
    await waitFor(
      () => {
        expect(result.current.departmentOrder).toEqual([DEPT_2, DEPT_1]);
      },
      { timeout: TEST_DEBOUNCE_MS / 2 },
    );
    // PATCH has NOT been sent yet in that optimistic window.
    expect(apiPatch).not.toHaveBeenCalled();

    // After the debounce window, the PATCH fires.
    await waitFor(
      () => {
        expect(apiPatch).toHaveBeenCalledTimes(1);
      },
      { timeout: TEST_DEBOUNCE_MS * 4 },
    );
    expect(apiPatch).toHaveBeenCalledWith(COMPANY_A, { departmentOrder: [DEPT_2, DEPT_1] });
  });

  it("setOrder coalesces rapid successive changes into one PATCH", async () => {
    apiGet.mockResolvedValue({ departmentOrder: [], projectOrder: [], updatedAt: null });
    apiPatch.mockResolvedValue({
      departmentOrder: [DEPT_1],
      projectOrder: [PROJ_1],
      updatedAt: "2026-04-20T00:00:00.000Z",
    });

    const { result } = renderHook(
      () => useSidebarOrder(COMPANY_A, { debounceMs: TEST_DEBOUNCE_MS }),
      { wrapper: wrapperWithQueryClient() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    act(() => {
      result.current.setOrder("department", [DEPT_2]);
      result.current.setOrder("department", [DEPT_1]);
      result.current.setOrder("project", [PROJ_1]);
    });

    await waitFor(() => {
      expect(apiPatch).toHaveBeenCalledTimes(1);
    });
    expect(apiPatch).toHaveBeenCalledWith(COMPANY_A, {
      departmentOrder: [DEPT_1],
      projectOrder: [PROJ_1],
    });
  });

  it("resetToDefault clears local state immediately and POSTs to reset endpoint", async () => {
    apiGet.mockResolvedValue({
      departmentOrder: [DEPT_1, DEPT_2],
      projectOrder: [PROJ_1],
      updatedAt: "2026-04-20T00:00:00.000Z",
    });
    apiReset.mockResolvedValue({
      departmentOrder: [],
      projectOrder: [],
      updatedAt: "2026-04-20T00:00:01.000Z",
    });

    const { result } = renderHook(() => useSidebarOrder(COMPANY_A), {
      wrapper: wrapperWithQueryClient(),
    });

    await waitFor(() => {
      expect(result.current.departmentOrder).toEqual([DEPT_1, DEPT_2]);
    });

    act(() => {
      result.current.resetToDefault();
    });

    await waitFor(() => {
      expect(result.current.departmentOrder).toEqual([]);
      expect(result.current.projectOrder).toEqual([]);
    });
    expect(apiReset).toHaveBeenCalledWith(COMPANY_A);
  });

  it("resetToDefault cancels a pending debounced PATCH", async () => {
    apiGet.mockResolvedValue({ departmentOrder: [], projectOrder: [], updatedAt: null });
    apiPatch.mockResolvedValue({ departmentOrder: [DEPT_1], projectOrder: [], updatedAt: null });
    apiReset.mockResolvedValue({ departmentOrder: [], projectOrder: [], updatedAt: null });

    const { result } = renderHook(
      () => useSidebarOrder(COMPANY_A, { debounceMs: TEST_DEBOUNCE_MS }),
      { wrapper: wrapperWithQueryClient() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    act(() => {
      result.current.setOrder("department", [DEPT_1]);
      result.current.resetToDefault();
    });

    // Give the debounce a chance to fire — it should NOT.
    await act(async () => {
      await sleep(TEST_DEBOUNCE_MS * 3);
    });

    await waitFor(() => {
      expect(apiReset).toHaveBeenCalledTimes(1);
    });
    expect(apiPatch).not.toHaveBeenCalled();
  });
});
