import type { NotificationPreferences } from "@armyofagents/shared";
import type { HubItemListRow } from "../api/hub-items";
import type { ToastInput } from "../context/ToastContext";

type HubToastDecision =
  | { show: true }
  | { show: false; reason: "digest" | "silent" | "quiet_hours" | "closed" };

function clockToMinutes(clock: string) {
  const [hours, minutes] = clock.split(":").map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
}

function localMinutes(now: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value ?? "", 10);
    const minute = Number.parseInt(parts.find((part) => part.type === "minute")?.value ?? "", 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

function isDuringQuietHours(
  quietHours: NotificationPreferences["quietHours"],
  now: Date,
) {
  if (!quietHours.enabled) return false;
  const current = localMinutes(now, quietHours.timezone);
  if (current === null) return true;
  const start = clockToMinutes(quietHours.start);
  const end = clockToMinutes(quietHours.end);
  if (start === end) return true;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

export function shouldToastHubItem(args: {
  item: Pick<HubItemListRow, "semanticType" | "id" | "version" | "status">;
  preferences: NotificationPreferences;
  now: Date;
}): HubToastDecision {
  if (args.item.status !== "open") return { show: false, reason: "closed" };

  const rule = args.preferences.rules.find(
    (candidate) => candidate.semanticType === args.item.semanticType,
  );
  if (!rule || !rule.toastEnabled) return { show: false, reason: "silent" };
  if (rule.deliveryMode === "silent") return { show: false, reason: "silent" };
  if (rule.deliveryMode === "digest") return { show: false, reason: "digest" };
  if (isDuringQuietHours(args.preferences.quietHours, args.now)) {
    return { show: false, reason: "quiet_hours" };
  }
  return { show: true };
}

function laneSlugForItem(item: Pick<HubItemListRow, "lane">) {
  if (item.lane === "waiting_on_you") return "waiting";
  if (item.lane === "suggestions") return "suggestions";
  return "notifications";
}

export function buildHubToastInput(companyId: string, item: HubItemListRow): ToastInput {
  return {
    dedupeKey: `hub:${companyId}:${item.id}:${item.version}`,
    title: item.title,
    body: item.summary ?? undefined,
    tone: item.priority === "urgent" || item.priority === "high" ? "warn" : "info",
    action: { label: "Open", href: `/inbox/${laneSlugForItem(item)}/${item.id}` },
    meta: { ref: item.sourceType ?? item.semanticType },
  };
}
