import type { PreferenceSection, UniversePreferences } from "@armyofagents/shared";

type Field = { section: PreferenceSection; label: string; applies: string };
export const UNIVERSE_FIELDS: Record<keyof UniversePreferences, Field> = {
  theme:{section:"appearance",label:"Theme",applies:"Universe only"}, density:{section:"appearance",label:"Density",applies:"Universe panels"},
  motion:{section:"appearance",label:"Motion",applies:"Canvas transitions"}, accent:{section:"appearance",label:"Accent",applies:"Highlights and focus"},
  blobStyle:{section:"appearance",label:"Blob style",applies:"Commander blob"}, blobColor:{section:"appearance",label:"Blob color",applies:"Commander blob"},
  grid:{section:"appearance",label:"Grid",applies:"Canvas background"}, gridIntensity:{section:"appearance",label:"Grid intensity",applies:"Canvas background"},
  dockPlacement:{section:"workspace",label:"Dock placement",applies:"Top tray"}, dockHiding:{section:"workspace",label:"Dock visibility",applies:"Top tray"},
  commanderPlacement:{section:"workspace",label:"Commander placement",applies:"Commander"}, conversationPresentation:{section:"workspace",label:"Conversation",applies:"Commander chat"},
  blobVisibility:{section:"workspace",label:"Blob",applies:"Commander"}, chatVisibility:{section:"workspace",label:"Chat",applies:"Commander"},
  captions:{section:"workspace",label:"Captions",applies:"Commander"}, captionSize:{section:"workspace",label:"Caption size",applies:"Captions"},
  captionPlacement:{section:"workspace",label:"Caption placement",applies:"Captions"}, restoreWorkspace:{section:"workspace",label:"Restore workspace",applies:"Next open"},
  openPanelPreviews:{section:"workspace",label:"Open-panel previews",applies:"Left rail"}, attentionPreviews:{section:"workspace",label:"Attention previews",applies:"Right rail"},
  snapToGrid:{section:"workspace",label:"Snap to grid",applies:"Next manipulation"}, arrangement:{section:"workspace",label:"Arrangement",applies:"Panel opening"},
  voiceConnectionId:{section:"voice",label:"Voice connection",applies:"Next voice session"}, voiceId:{section:"voice",label:"Voice",applies:"Next voice session"},
  language:{section:"voice",label:"Language",applies:"Next voice session"}, spokenLength:{section:"voice",label:"Spoken length",applies:"Next response"},
  personalVoiceInstructions:{section:"voice",label:"Personal voice instructions",applies:"Next response"}, soundEffects:{section:"voice",label:"Sound effects",applies:"Shared notification policy"},
  spokenAnnouncements:{section:"voice",label:"Spoken announcements",applies:"Shared notification policy"}, browserViewQuality:{section:"browser",label:"Browser quality",applies:"Next renegotiation"},
};
