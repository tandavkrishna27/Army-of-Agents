import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HomeBoardLayoutItem } from "@armyofagents/shared";

const apiGet = vi.fn();
const apiSave = vi.fn();
const apiReset = vi.fn();

vi.mock("@/api/home-board-layout", () => ({
  homeBoardLayoutApi: {
    get: (...args: unknown[]) => apiGet(...args),
    save: (...args: unknown[]) => apiSave(...args),
    reset: (...args: unknown[]) => apiReset(...args),
  },
}));

import { useHomeBoardLayout } from "../hooks/useHomeBoardLayout";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";

const LAYOUT_A: HomeBoardLayoutItem[] = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
const LAYOUT_B: HomeBoardLayoutItem[] = [
  { i: "budget", x: 0, y: 0, w: 1, h: 1 },
  { i: "agents-now", x: 1, y: 0, w: 1, h: 1 },
];

function wrapperWithQueryClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe("useHomeBoardLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not call the API when companyId is missing", async () => {
    const { result } = renderHook(() => useHomeBoardLayout(null), {
      wrapper: wrapperWithQueryClient(),
    });
    expect(apiGet).not.toHaveBeenCalled();
    expect(result.current.layout).toBeNull();
  });

  it("loads the saved layout", async () => {
    apiGet.mockResolvedValue({ layout: LAYOUT_A, schemaVersion: 1 });

    const { result } = renderHook(() => useHomeBoardLayout(COMPANY_A), {
      wrapper: wrapperWithQueryClient(),
    });

    await waitFor(() => {
      expect(result.current.layout).toEqual(LAYOUT_A);
    });
    expect(result.current.schemaVersion).toBe(1);
    expect(apiGet).toHaveBeenCalledWith(COMPANY_A);
  });

  it("exposes a null layout when the user has no saved board", async () => {
    apiGet.mockResolvedValue(null);

    const { result } = renderHook(() => useHomeBoardLayout(COMPANY_A), {
      wrapper: wrapperWithQueryClient(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.layout).toBeNull();
  });

  it("save calls the API with the layout and updates optimistically before it resolves", async () => {
    apiGet.mockResolvedValue({ layout: LAYOUT_A, schemaVersion: 1 });
    let resolveSave: (value: { layout: HomeBoardLayoutItem[]; schemaVersion: number }) => void;
    apiSave.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );

    const { result } = renderHook(() => useHomeBoardLayout(COMPANY_A), {
      wrapper: wrapperWithQueryClient(),
    });

    await waitFor(() => {
      expect(result.current.layout).toEqual(LAYOUT_A);
    });

    act(() => {
      result.current.save(LAYOUT_B);
    });

    // Optimistic update is visible immediately, before the PATCH resolves.
    await waitFor(() => {
      expect(result.current.layout).toEqual(LAYOUT_B);
    });
    expect(apiSave).toHaveBeenCalledWith(COMPANY_A, LAYOUT_B);

    await act(async () => {
      resolveSave!({ layout: LAYOUT_B, schemaVersion: 1 });
      await Promise.resolve();
    });
  });

  it("rolls back to the previous layout when save fails", async () => {
    apiGet.mockResolvedValue({ layout: LAYOUT_A, schemaVersion: 1 });
    // A manually-controlled rejection (rather than mockRejectedValue, which
    // settles the mutation synchronously-ish) gives us a real window to
    // observe the optimistic value before the rollback happens, instead of
    // racing waitFor against an already-settled promise.
    let rejectSave: (err: Error) => void;
    apiSave.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      }),
    );

    const { result } = renderHook(() => useHomeBoardLayout(COMPANY_A), {
      wrapper: wrapperWithQueryClient(),
    });

    await waitFor(() => {
      expect(result.current.layout).toEqual(LAYOUT_A);
    });

    act(() => {
      result.current.save(LAYOUT_B);
    });

    // Optimistic update happens first...
    await waitFor(() => {
      expect(result.current.layout).toEqual(LAYOUT_B);
    });

    await act(async () => {
      rejectSave!(new Error("save failed"));
      await Promise.resolve().catch(() => {});
    });

    // ...then rolls back once the mutation rejects.
    await waitFor(() => {
      expect(result.current.layout).toEqual(LAYOUT_A);
    });
    expect(result.current.saveError).toBeTruthy();
  });

  it("reset calls the API and clears the layout", async () => {
    apiGet.mockResolvedValue({ layout: LAYOUT_A, schemaVersion: 1 });
    apiReset.mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useHomeBoardLayout(COMPANY_A), {
      wrapper: wrapperWithQueryClient(),
    });

    await waitFor(() => {
      expect(result.current.layout).toEqual(LAYOUT_A);
    });

    // Reflect what the real backend returns once onSettled's invalidateQueries
    // triggers the post-reset refetch (the row is gone -> null), so the
    // assertion below is robust whether it observes the optimistic null or
    // the refetched null.
    apiGet.mockResolvedValue(null);

    act(() => {
      result.current.reset();
    });

    await waitFor(() => {
      expect(result.current.layout).toBeNull();
    });
    expect(apiReset).toHaveBeenCalledWith(COMPANY_A);
  });
});
