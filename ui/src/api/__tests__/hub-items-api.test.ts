import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const patch = vi.fn();
const post = vi.fn();

vi.mock("../client", () => ({
  api: {
    get: (...args: unknown[]) => get(...args),
    patch: (...args: unknown[]) => patch(...args),
    post: (...args: unknown[]) => post(...args),
  },
}));

import { hubItemsApi, normalizeHubListResponse, type HubItemListRow } from "../hub-items";

describe("hubItemsApi", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists lane-filtered hub items", async () => {
    get.mockResolvedValueOnce([]);

    await hubItemsApi.list("company-1", {
      lane: "waiting_on_you",
      status: "open",
      limit: 50,
    });

    expect(get).toHaveBeenCalledWith(
      "/companies/company-1/hub-items?lane=waiting_on_you&status=open&limit=50",
    );
  });

  it("lists with default limit when optional params are omitted", async () => {
    get.mockResolvedValueOnce([]);

    await hubItemsApi.list("company-1");

    expect(get).toHaveBeenCalledWith("/companies/company-1/hub-items?limit=50");
  });

  it("serializes includeDismissed and clamps numeric limits", async () => {
    get.mockResolvedValueOnce([]);
    await hubItemsApi.list("company-1", { includeDismissed: true, limit: 500 });

    expect(get).toHaveBeenCalledWith(
      "/companies/company-1/hub-items?includeDismissed=true&limit=50",
    );

    get.mockClear();
    get.mockResolvedValueOnce([]);
    await hubItemsApi.list("company-1", { limit: 0 });

    expect(get).toHaveBeenCalledWith("/companies/company-1/hub-items?limit=1");
  });

  it("serializes includeSnoozed for explicit snoozed views", async () => {
    get.mockResolvedValueOnce([]);

    await hubItemsApi.list("company-1", { includeSnoozed: true });

    expect(get).toHaveBeenCalledWith(
      "/companies/company-1/hub-items?includeSnoozed=true&limit=50",
    );
  });

  it("builds W1d list query params", async () => {
    get.mockResolvedValueOnce({ items: [], nextCursor: null, totalKnown: null });

    await hubItemsApi.list("company-1", {
      lane: "waiting_on_you",
      status: "open",
      q: "deploy",
      groupMode: "auto",
      cursor: "abc",
      limit: 25,
    });

    expect(get).toHaveBeenCalledWith(
      "/companies/company-1/hub-items?lane=waiting_on_you&status=open&q=deploy&groupMode=auto&cursor=abc&limit=25",
    );
  });

  it("normalizes legacy bare-array list responses", () => {
    expect(normalizeHubListResponse([{ id: "hub-1" } as HubItemListRow])).toEqual({
      items: [{ id: "hub-1" }],
      nextCursor: null,
      totalKnown: null,
    });
  });

  it("falls back to default limit for non-finite caller input", async () => {
    get.mockResolvedValueOnce([]);

    await hubItemsApi.list("company-1", { limit: Number.NaN });

    expect(get).toHaveBeenCalledWith("/companies/company-1/hub-items?limit=50");
  });

  it("fetches counts", async () => {
    get.mockResolvedValueOnce({ open: 2, unread: 1 });

    await hubItemsApi.counts("company-1");

    expect(get).toHaveBeenCalledWith("/companies/company-1/hub-items/counts");
  });

  it("reads, updates, and resets hub preferences", async () => {
    get.mockResolvedValueOnce({ defaultLanding: "home" });
    patch.mockResolvedValueOnce({ density: "compact" });
    post.mockResolvedValueOnce({ defaultLanding: "home" });

    await hubItemsApi.getPreferences("company-1");
    await hubItemsApi.updatePreferences("company-1", { density: "compact" });
    await hubItemsApi.resetPreferences("company-1");

    expect(get).toHaveBeenCalledWith("/companies/company-1/hub-items/preferences/me");
    expect(patch).toHaveBeenCalledWith(
      "/companies/company-1/hub-items/preferences/me",
      { density: "compact" },
    );
    expect(post).toHaveBeenCalledWith(
      "/companies/company-1/hub-items/preferences/me/reset",
      {},
    );
  });

  it("reads, updates, resets, and lists hub autopilot resources", async () => {
    get.mockResolvedValueOnce({ mode: "off", handledToday: 0, lastHandledAt: null, rules: [], updatedAt: null });
    patch.mockResolvedValueOnce({ mode: "drive", handledToday: 0, lastHandledAt: null, rules: [], updatedAt: null });
    post.mockResolvedValueOnce({ mode: "off", handledToday: 0, lastHandledAt: null, rules: [], updatedAt: null });
    get.mockResolvedValueOnce({ items: [] });

    await hubItemsApi.autopilotPolicy.get("company-1");
    await hubItemsApi.autopilotPolicy.update("company-1", { mode: "drive" });
    await hubItemsApi.autopilotPolicy.reset("company-1");
    await hubItemsApi.autopilotActions.list("company-1");

    expect(get).toHaveBeenCalledWith("/companies/company-1/hub-autopilot/policy");
    expect(patch).toHaveBeenCalledWith("/companies/company-1/hub-autopilot/policy", { mode: "drive" });
    expect(post).toHaveBeenCalledWith("/companies/company-1/hub-autopilot/policy/reset", {});
    expect(get).toHaveBeenCalledWith("/companies/company-1/hub-autopilot/actions");
  });

  it("marks an item read through sparse state route", async () => {
    patch.mockResolvedValueOnce({});

    await hubItemsApi.markRead("company-1", "hub-1");

    expect(patch).toHaveBeenCalledWith(
      "/companies/company-1/hub-items/hub-1/state",
      { kind: "read" },
    );
  });

  it("sends all personal-state mutation bodies through the sparse state route", async () => {
    patch.mockResolvedValue({});

    await hubItemsApi.markUnread("company-1", "hub-1");
    await hubItemsApi.snooze("company-1", "hub-1", "2026-07-01T00:00:00.000Z");
    await hubItemsApi.unsnooze("company-1", "hub-1");
    await hubItemsApi.dismiss("company-1", "hub-1");
    await hubItemsApi.undismiss("company-1", "hub-1");

    expect(patch).toHaveBeenNthCalledWith(
      1,
      "/companies/company-1/hub-items/hub-1/state",
      { kind: "unread" },
    );
    expect(patch).toHaveBeenNthCalledWith(
      2,
      "/companies/company-1/hub-items/hub-1/state",
      { kind: "snooze", until: "2026-07-01T00:00:00.000Z" },
    );
    expect(patch).toHaveBeenNthCalledWith(
      3,
      "/companies/company-1/hub-items/hub-1/state",
      { kind: "unsnooze" },
    );
    expect(patch).toHaveBeenNthCalledWith(
      4,
      "/companies/company-1/hub-items/hub-1/state",
      { kind: "dismiss" },
    );
    expect(patch).toHaveBeenNthCalledWith(
      5,
      "/companies/company-1/hub-items/hub-1/state",
      { kind: "undismiss" },
    );
  });

  it("posts lifecycle action, undo, bulk, and audit requests to the W1c routes", async () => {
    post.mockResolvedValue({});
    get.mockResolvedValueOnce([]);

    await hubItemsApi.act("company-1", "hub-1", {
      action: "resolve",
      expectedVersion: 2,
      reason: "Done",
    });
    await hubItemsApi.undo("company-1", "hub-1", {
      auditId: "audit-1",
      expectedVersion: 3,
    });
    await hubItemsApi.bulkAction("company-1", {
      bulkId: "bulk-1",
      items: [{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", action: "dismiss" }],
    });
    await hubItemsApi.audit("company-1", "hub-1");

    expect(post).toHaveBeenNthCalledWith(
      1,
      "/companies/company-1/hub-items/hub-1/action",
      { action: "resolve", expectedVersion: 2, reason: "Done" },
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/companies/company-1/hub-items/hub-1/undo",
      { auditId: "audit-1", expectedVersion: 3 },
    );
    expect(post).toHaveBeenNthCalledWith(
      3,
      "/companies/company-1/hub-items/bulk-action",
      {
        bulkId: "bulk-1",
        items: [{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", action: "dismiss" }],
      },
    );
    expect(get).toHaveBeenCalledWith("/companies/company-1/hub-items/hub-1/audit");
  });
});
