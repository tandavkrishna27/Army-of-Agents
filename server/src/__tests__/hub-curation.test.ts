import { beforeEach, describe, expect, it, vi } from "vitest";

const publishLiveEventMock = vi.hoisted(() => vi.fn());

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: publishLiveEventMock,
}));

import {
  deriveCurationForHubItem,
  hubCurationService,
  type HubCurationSourceItem,
} from "../services/hub-curation.js";

const baseItem: HubCurationSourceItem = {
  id: "hub-1",
  companyId: "company-1",
  semanticType: "run_failed",
  sourceType: "heartbeat_run",
  scopeKey: "engineering",
  groupKey: null,
  ownerUserId: "user-1",
  ownerPool: null,
  priority: "normal",
  slaAt: null,
  version: 4,
  curationRevision: 2,
};

describe("hub curation", () => {
  beforeEach(() => {
    publishLiveEventMock.mockClear();
  });

  it("keeps an explicit group key stable", () => {
    const result = deriveCurationForHubItem({
      ...baseItem,
      groupKey: "source:approval",
      sourceType: "approval",
    });

    expect(result.effectiveGroupKey).toBe("source:approval");
    expect(result.curationGroupLabel).toBe("approval");
  });

  it("does not merge board-pool and owner-specific items into the same derived group", () => {
    const ownerItem = deriveCurationForHubItem(baseItem);
    const boardItem = deriveCurationForHubItem({
      ...baseItem,
      id: "hub-2",
      ownerUserId: null,
      ownerPool: "board",
    });

    expect(ownerItem.effectiveGroupKey).toContain("owner:user-1");
    expect(boardItem.effectiveGroupKey).toContain("pool:board");
    expect(ownerItem.effectiveGroupKey).not.toBe(boardItem.effectiveGroupKey);
  });

  it("keeps derived groups company-scoped", () => {
    const first = deriveCurationForHubItem(baseItem);
    const second = deriveCurationForHubItem({ ...baseItem, companyId: "company-2" });

    expect(first.effectiveGroupKey).toContain("company-1");
    expect(second.effectiveGroupKey).toContain("company-2");
    expect(first.effectiveGroupKey).not.toBe(second.effectiveGroupKey);
  });

  it("adds useful priority and SLA reasons without bumping lifecycle version", () => {
    const result = deriveCurationForHubItem(
      {
        ...baseItem,
        priority: "urgent",
        slaAt: "2026-07-01T10:20:00.000Z",
      },
      new Date("2026-07-01T10:00:00.000Z"),
    );

    expect(result.curationPriorityReason).toContain("Urgent");
    expect(result.curationReason).toContain("SLA");
    expect(result.nextCurationRevision).toBe(3);
    expect(result.nextVersion).toBe(4);
  });

  it("stays quiet for normal items with no nearby SLA", () => {
    const result = deriveCurationForHubItem(baseItem);

    expect(result.curationPriorityReason).toBeNull();
    expect(result.curationReason).toBeNull();
  });

  it("updates curation metadata by curation revision and publishes a metadata refresh without changing lifecycle version", async () => {
    const returning = vi.fn().mockResolvedValue([
      {
        id: "hub-1",
        companyId: "company-1",
        semanticType: "run_failed",
        status: "open",
        version: 4,
      },
    ]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const db = { update } as any;

    const result = await hubCurationService(db, {
      now: () => new Date("2026-07-01T10:00:00.000Z"),
    }).updateSummary({
      companyId: "company-1",
      hubItemId: "hub-1",
      expectedCurationRevision: 2,
      curationGroupLabel: "Failed runs",
      curationGroupSummary: "3 failed runs need review.",
      curationReason: "SLA is due in 20 minutes.",
      curationPriorityReason: "Urgent priority is set on this hub item.",
      curatedByAgentId: "11111111-1111-4111-8111-111111111111",
    });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        curationGroupLabel: "Failed runs",
        curationRevision: 3,
        curatedByAgentId: "11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(result.version).toBe(4);
    expect(publishLiveEventMock).toHaveBeenCalledWith({
      companyId: "company-1",
      type: "hub.item.changed",
      payload: expect.objectContaining({
        itemId: "hub-1",
        semanticType: "run_failed",
        lane: "notifications",
        status: "open",
        version: 4,
        change: "updated",
      }),
    });
    expect(publishLiveEventMock).toHaveBeenCalledTimes(1);
    expect(publishLiveEventMock.mock.calls[0][0].type).not.toBe("hub.counts.changed");
  });

  it("bounds curation metadata before writing", async () => {
    const set = vi.fn();
    const update = vi.fn(() => ({ set }));
    const db = { update } as any;

    await expect(
      hubCurationService(db).updateSummary({
        companyId: "company-1",
        hubItemId: "hub-1",
        expectedCurationRevision: 2,
        curationGroupLabel: "x".repeat(121),
      }),
    ).rejects.toMatchObject({ status: 422 });

    expect(update).not.toHaveBeenCalled();
  });

  it("redacts secret-looking curation text before persisting", async () => {
    const returning = vi.fn().mockResolvedValue([
      {
        id: "hub-1",
        companyId: "company-1",
        semanticType: "run_failed",
        status: "open",
        version: 4,
      },
    ]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const db = { update } as any;

    await hubCurationService(db).updateSummary({
      companyId: "company-1",
      hubItemId: "hub-1",
      expectedCurationRevision: 2,
      curationGroupSummary: "Provider rejected sk-ant-abc123DEF456ghi789.",
    });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        curationGroupSummary: "Provider rejected ***REDACTED***.",
      }),
    );
  });

  it("preserves omitted curation fields when Steward writes only a group summary", async () => {
    const returning = vi.fn().mockResolvedValue([
      {
        id: "hub-1",
        companyId: "company-1",
        semanticType: "run_failed",
        status: "open",
        version: 4,
      },
    ]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const db = { update } as any;

    await hubCurationService(db).updateSummary({
      companyId: "company-1",
      hubItemId: "hub-1",
      expectedCurationRevision: 2,
      curationGroupSummary: "These failed runs share the same blocked release.",
      curatedByAgentId: "11111111-1111-4111-8111-111111111111",
    });

    const setPayload = set.mock.calls[0][0];
    expect(setPayload).not.toHaveProperty("curationGroupLabel");
    expect(setPayload).not.toHaveProperty("curationReason");
    expect(setPayload).not.toHaveProperty("curationPriorityReason");
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        curationGroupSummary: "These failed runs share the same blocked release.",
        curationRevision: 3,
      }),
    );
  });
});
