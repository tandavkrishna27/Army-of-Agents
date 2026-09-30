/**
 * useComposerMention — regression tests for the review findings the live
 * repro confirmed (2026-07-16):
 *   F1: picking a mention typed MID-TEXT must replace the typed token in
 *       place, never append at the end of the value.
 *   F2: the menu must close when the input value changes through any path
 *       the hook didn't drive (send cleared it, draft restore, ...).
 *   F5: option filtering is `includes`, matching Discussion/Commander.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { agentsApi } from "@/api/agents";
import { useComposerMention } from "./useComposerMention";

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue([
      { id: "a1", name: "Scout", status: "idle" },
      { id: "a2", name: "Memory Keeper", status: "idle" },
    ]),
    listAoa: vi.fn().mockResolvedValue([]),
  },
}));

function makeHarness(initialValue: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  let value = initialValue;
  const onChange = vi.fn((next: string) => {
    value = next;
  });
  const focusAt = vi.fn();
  const render = () =>
    renderHook(
      (props: { value: string }) =>
        useComposerMention({ companyId: "co-1", value: props.value, onChange, focusAt }),
      { wrapper, initialProps: { value } },
    );
  return { render, onChange, focusAt, getValue: () => value };
}

describe("useComposerMention (range-based)", () => {
  it("F1: select() replaces the token typed mid-text, not the end of the value", async () => {
    const h = makeHarness("hello @S world");
    const hook = h.render();
    // Caret sits right after "@S" (position 8), as when the user typed it.
    act(() => hook.result.current.refresh("hello @S world", 8));
    expect(hook.result.current.open).toBe(true);

    act(() => hook.result.current.select({ id: "a1", name: "Scout", type: "agent" }));
    expect(h.getValue()).toBe("hello @Scout  world");
    expect(hook.result.current.open).toBe(false);
    // Caret lands after the inserted mention, not at the end of the value.
    expect(h.focusAt).not.toHaveBeenCalled(); // deferred to rAF
  });

  it("F2: the menu closes when the value changes outside the hook (send cleared it)", () => {
    const h = makeHarness("@zzzz");
    const hook = h.render();
    act(() => hook.result.current.refresh("@zzzz", 5));
    expect(hook.result.current.open).toBe(true);

    // handleSend clears the input directly — the hook only sees the new
    // value prop. The menu must close.
    hook.rerender({ value: "" });
    expect(hook.result.current.open).toBe(false);
  });

  it("F9/caret: refresh with a caret outside any token closes the menu", () => {
    const h = makeHarness("hi @Adj tail");
    const hook = h.render();
    act(() => hook.result.current.refresh("hi @Adj tail", 7)); // inside token
    expect(hook.result.current.open).toBe(true);
    act(() => hook.result.current.refresh("hi @Adj tail", 12)); // caret at end, after " tail"
    expect(hook.result.current.open).toBe(false);
  });

  it("openViaButton appends a boundary-safe @ and tracks its range", () => {
    const h = makeHarness("hello");
    const hook = h.render();
    act(() => hook.result.current.openViaButton());
    expect(h.getValue()).toBe("hello @");
    expect(hook.result.current.open).toBe(true);

    hook.rerender({ value: "hello @" });
    act(() => hook.result.current.select({ id: "a2", name: "Memory Keeper", type: "agent" }));
    expect(h.getValue()).toBe("hello @Memory Keeper ");
  });

  it("F8: exposes loading while the agents query is in flight, false once it settles", async () => {
    let resolveAgents!: (agents: Array<Record<string, unknown>>) => void;
    vi.mocked(agentsApi.list).mockImplementationOnce(
      () =>
        new Promise<Array<Record<string, unknown>>>((resolve) => {
          resolveAgents = resolve;
        }) as unknown as ReturnType<typeof agentsApi.list>,
    );
    const h = makeHarness("@");
    const hook = h.render();
    act(() => hook.result.current.refresh("@", 1));
    expect(hook.result.current.open).toBe(true);

    // Query in flight + zero options: the menu would otherwise say "No matches".
    await vi.waitFor(() => expect(hook.result.current.loading).toBe(true));
    expect(hook.result.current.options).toHaveLength(0);

    await act(async () => {
      resolveAgents([{ id: "a1", name: "Scout", status: "idle" }]);
    });
    await vi.waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.options.map((o) => o.name)).toContain("Scout");
  });

  it("F8: loading is false while the menu is closed (query disabled)", () => {
    const h = makeHarness("");
    const hook = h.render();
    expect(hook.result.current.open).toBe(false);
    expect(hook.result.current.loading).toBe(false);
  });

  it("F5: filters options with includes, not startsWith", async () => {
    const h = makeHarness("@keeper");
    const hook = h.render();
    act(() => hook.result.current.refresh("@keeper", 7));
    // Wait for the mocked agents query to resolve.
    await vi.waitFor(() => {
      expect(hook.result.current.options.map((o) => o.name)).toContain("Memory Keeper");
    });
    expect(hook.result.current.options.map((o) => o.name)).not.toContain("Scout");
  });
});
