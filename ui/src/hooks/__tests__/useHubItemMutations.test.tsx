import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hubItemsApi } from "@/api/hub-items";
import { queryKeys } from "@/lib/queryKeys";
import { useHubItemMutations } from "../useHubItemMutations";

vi.mock("@/api/hub-items", () => ({
  hubItemsApi: {
    act: vi.fn(),
    bulkAction: vi.fn(),
    dismiss: vi.fn(),
    markRead: vi.fn(),
    markUnread: vi.fn(),
    snooze: vi.fn(),
    undo: vi.fn(),
    undismiss: vi.fn(),
    unsnooze: vi.fn(),
  },
}));

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe("useHubItemMutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates hub list and counts after a successful lifecycle action", async () => {
    vi.mocked(hubItemsApi.act).mockResolvedValue({ item: { id: "hub-1" } });
    const queryClient = makeClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useHubItemMutations("company-1"), {
      wrapper: wrapperFor(queryClient),
    });

    await act(async () => {
      await result.current.act.mutateAsync({
        itemId: "hub-1",
        payload: { action: "resolve", expectedVersion: 1 },
      });
    });

    expect(hubItemsApi.act).toHaveBeenCalledWith("company-1", "hub-1", {
      action: "resolve",
      expectedVersion: 1,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["hub-items", "company-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.hubItems.counts("company-1"),
    });
  });

  it("invalidates hub queries on a 409 conflict so stale rows refetch", async () => {
    vi.mocked(hubItemsApi.act).mockRejectedValue(
      Object.assign(new Error("Changed elsewhere"), { status: 409 }),
    );
    const queryClient = makeClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useHubItemMutations("company-1"), {
      wrapper: wrapperFor(queryClient),
    });

    await expect(
      result.current.act.mutateAsync({
        itemId: "hub-1",
        payload: { action: "archive", expectedVersion: 1 },
      }),
    ).rejects.toThrow("Changed elsewhere");

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["hub-items", "company-1"] });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.hubItems.counts("company-1"),
    });
  });

  it("restores personal state by calling the inverse state mutation", async () => {
    vi.mocked(hubItemsApi.markUnread).mockResolvedValue({});
    vi.mocked(hubItemsApi.unsnooze).mockResolvedValue({});
    vi.mocked(hubItemsApi.undismiss).mockResolvedValue({});
    const queryClient = makeClient();
    const { result } = renderHook(() => useHubItemMutations("company-1"), {
      wrapper: wrapperFor(queryClient),
    });

    await act(async () => {
      await result.current.undoPersonalState({
        itemId: "hub-1",
        restore: { kind: "unread" },
      });
      await result.current.undoPersonalState({
        itemId: "hub-1",
        restore: { kind: "unsnooze" },
      });
      await result.current.undoPersonalState({
        itemId: "hub-1",
        restore: { kind: "undismiss" },
      });
    });

    expect(hubItemsApi.markUnread).toHaveBeenCalledWith("company-1", "hub-1");
    expect(hubItemsApi.unsnooze).toHaveBeenCalledWith("company-1", "hub-1");
    expect(hubItemsApi.undismiss).toHaveBeenCalledWith("company-1", "hub-1");
  });
});
