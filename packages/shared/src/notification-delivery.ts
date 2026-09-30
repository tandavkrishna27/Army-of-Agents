import type {NotificationPreferences, NotificationPreferenceRule} from "./notification-preferences.js";
import type {UniversePreferences} from "./validators/universe-preferences.js";

export type DeliveryChannel="toast"|"sound"|"voice";
export type DeliveryLocalState={dnd:boolean;soundEffects:boolean;quieter:boolean;activeVoiceConversation:boolean;userSpeaking:boolean;playbackEnabled:boolean};

export function personalDeliveryRestrictions(p:Pick<UniversePreferences,"soundEffects"|"spokenAnnouncements">){
  return {soundEffects:p.soundEffects,quieter:p.spokenAnnouncements==="quieter"};
}

export function channelPermitted(channel:DeliveryChannel,rule:Pick<NotificationPreferenceRule,"deliveryMode"|"toastEnabled"|"soundEnabled"|"voiceEnabled">,local:DeliveryLocalState){
  if(local.dnd||rule.deliveryMode!=="realtime") return false;
  if(channel==="toast") return rule.toastEnabled;
  if(channel==="sound") return rule.soundEnabled===true&&local.soundEffects;
  return rule.voiceEnabled===true&&local.activeVoiceConversation&&!local.userSpeaking&&local.playbackEnabled&&!local.quieter;
}

function minutes(clock:string){const [h,m]=clock.split(":").map(Number);return h*60+m;}
export function isNotificationQuietHour(policy:NotificationPreferences["quietHours"],now:Date){
  if(!policy.enabled)return false;
  try{
    const parts=new Intl.DateTimeFormat("en-US",{timeZone:policy.timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now);
    const current=Number(parts.find(p=>p.type==="hour")?.value)*60+Number(parts.find(p=>p.type==="minute")?.value);
    if(!Number.isFinite(current))return true;
    const start=minutes(policy.start),end=minutes(policy.end);
    return start===end|| (start<end ? current>=start&&current<end : current>=start||current<end);
  }catch{return true;}
}

export function evaluateNotificationDelivery(input:{channel:DeliveryChannel;status:string;rule:NotificationPreferenceRule|undefined;preferences:Pick<NotificationPreferences,"quietHours">;local:DeliveryLocalState;now:Date}){
  if(input.status!=="open")return {eligible:false,reason:"closed"} as const;
  if(!input.rule)return {eligible:false,reason:"missing_rule"} as const;
  if(input.rule.deliveryMode==="digest")return {eligible:false,reason:"digest"} as const;
  if(input.rule.deliveryMode==="silent")return {eligible:false,reason:"silent"} as const;
  if(isNotificationQuietHour(input.preferences.quietHours,input.now))return {eligible:false,reason:"quiet_hours"} as const;
  return channelPermitted(input.channel,input.rule,input.local)?{eligible:true,reason:"eligible"} as const:{eligible:false,reason:"restricted"} as const;
}
