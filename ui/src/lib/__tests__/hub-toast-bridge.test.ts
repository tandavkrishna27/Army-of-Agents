import { describe, expect, it } from "vitest";
import type { NotificationPreferences } from "@armyofagents/shared";
import type { HubItemListRow } from "../../api/hub-items";
import { buildHubToastInput, shouldToastHubItem } from "../hub-toast-bridge";

const realtimePrefs: NotificationPreferences = {
  rules: [
    { semanticType: "approval_request", deliveryMode: "realtime", toastEnabled: true },
  ],
  quietHours: { enabled: false, start: "18:00", end: "09:00", timezone: "UTC" },
  digest: { enabled: true, cadence: "daily" },
  updatedAt: null,
};

const item = {
  id: "hub-1",
  companyId: "company-1",
  semanticType: "approval_request",
  lane: "waiting_on_you",
  status: "open",
  priority: "high",
  title: "Approve deployment",
  summary: "Needs your decision",
  sourceType: "approval",
  sourceId: "approval-1",
  ownerUserId: null,
  ownerPool: null,
  claimedByUserId: null,
  claimedAt: null,
  version: 3,
  createdAt: "2026-06-30T00:00:00.000Z",
  updatedAt: "2026-06-30T00:00:00.000Z",
  readAt: null,
  snoozedUntil: null,
  dismissedAt: null,
  groupKey: null,
  groupLabel: null,
  groupCount: null,
  scopeKey: null,
  slaAt: null,
} satisfies HubItemListRow;

function prefs(patch: Partial<NotificationPreferences>): NotificationPreferences {
  return {
    ...realtimePrefs,
    ...patch,
    quietHours: { ...realtimePrefs.quietHours, ...patch.quietHours },
    digest: { ...realtimePrefs.digest, ...patch.digest },
  };
}

describe("hub toast bridge", () => {
  it("allows realtime toast when preference is realtime and toast is enabled", () => {
    expect(
      shouldToastHubItem({
        item,
        preferences: realtimePrefs,
        now: new Date("2026-06-30T12:00:00.000Z"),
      }),
    ).toEqual({ show: true });
  });

  it("suppresses digest and silent delivery", () => {
    expect(
      shouldToastHubItem({
        item,
        preferences: prefs({
          rules: [{ semanticType: "approval_request", deliveryMode: "digest", toastEnabled: true }],
        }),
        now: new Date("2026-06-30T12:00:00.000Z"),
      }),
    ).toEqual({ show: false, reason: "digest" });
    expect(
      shouldToastHubItem({
        item,
        preferences: prefs({
          rules: [{ semanticType: "approval_request", deliveryMode: "silent", toastEnabled: true }],
        }),
        now: new Date("2026-06-30T12:00:00.000Z"),
      }),
    ).toEqual({ show: false, reason: "silent" });
  });

  it("suppresses realtime when toasts are disabled or the item is closed", () => {
    expect(
      shouldToastHubItem({
        item,
        preferences: prefs({
          rules: [{ semanticType: "approval_request", deliveryMode: "realtime", toastEnabled: false }],
        }),
        now: new Date("2026-06-30T12:00:00.000Z"),
      }),
    ).toEqual({ show: false, reason: "silent" });
    expect(
      shouldToastHubItem({
        item: { ...item, status: "resolved" },
        preferences: realtimePrefs,
        now: new Date("2026-06-30T12:00:00.000Z"),
      }),
    ).toEqual({ show: false, reason: "closed" });
  });

  it("suppresses realtime during same-day and overnight quiet hours", () => {
    expect(
      shouldToastHubItem({
        item,
        preferences: prefs({
          quietHours: { enabled: true, start: "09:00", end: "17:00", timezone: "UTC" },
        }),
        now: new Date("2026-06-30T12:00:00.000Z"),
      }),
    ).toEqual({ show: false, reason: "quiet_hours" });
    expect(
      shouldToastHubItem({
        item,
        preferences: prefs({
          quietHours: { enabled: true, start: "18:00", end: "09:00", timezone: "UTC" },
        }),
        now: new Date("2026-06-30T23:00:00.000Z"),
      }),
    ).toEqual({ show: false, reason: "quiet_hours" });
  });

  it("builds a hydrated item toast without depending on live event text", () => {
    expect(buildHubToastInput("company-1", item)).toMatchObject({
      dedupeKey: "hub:company-1:hub-1:3",
      title: "Approve deployment",
      body: "Needs your decision",
      tone: "warn",
      action: { label: "Open", href: "/inbox/waiting/hub-1" },
      meta: { ref: "approval" },
    });
  });
});
