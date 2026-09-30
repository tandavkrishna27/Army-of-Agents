import type { NotificationPreferences } from "@armyofagents/shared";
import type { HubItemListRow } from "../api/hub-items";
import type { ToastInput } from "../context/ToastContext";
import {evaluateNotificationDelivery} from "@armyofagents/shared";

type HubToastDecision =
  | { show: true }
  | { show: false; reason: "digest" | "silent" | "quiet_hours" | "closed" };

export function shouldToastHubItem(args: {
  item: Pick<HubItemListRow, "semanticType" | "id" | "version" | "status">;
  preferences: NotificationPreferences;
  now: Date;
}): HubToastDecision {
  const rule = args.preferences.rules.find(
    (candidate) => candidate.semanticType === args.item.semanticType,
  );
  const decision=evaluateNotificationDelivery({channel:"toast",status:args.item.status,rule,
    preferences:args.preferences,now:args.now,local:{dnd:false,soundEffects:false,quieter:true,activeVoiceConversation:false,userSpeaking:false,playbackEnabled:false}});
  if(decision.eligible)return {show:true};
  const reason=decision.reason==="digest"?"digest":decision.reason==="quiet_hours"?"quiet_hours":decision.reason==="closed"?"closed":"silent";
  return {show:false,reason};
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
