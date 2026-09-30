// E1.5 Commander presentation state — independent of the canonical conversation
// and of any voice session. Chat view, blob and captions are separate; one
// composer draft (E1.3) spans all chat sizes. Microphone/session commands belong
// to E3.2, never here. Types/functions are verbatim from coding-plans/e1-5.md.

export type ChatView = "compact" | "expanded" | "maximized" | "tucked";

export type Presentation = {
  chat: ChatView;
  lastVisible: Exclude<ChatView, "tucked">;
  blob: boolean;
  captions: boolean;
  chatFrontmost: boolean;
};

// First-use defaults (E1.5/1): compact chat input and a visible blob; captions
// off until a voice utterance. Saved E8.1 preferences override these.
export const initialPresentation = (): Presentation => ({
  chat: "compact",
  lastVisible: "compact",
  blob: true,
  captions: false,
  chatFrontmost: true,
});

// Main Commander (tray/blob) click: restore hidden chat, else bring a covered
// chat forward, else tuck the frontmost chat. Affects chat only — never blob,
// captions or the voice session.
export function toggleTrayChat(s: Presentation): Presentation {
  if (s.chat === "tucked")
    return { ...s, chat: s.lastVisible, chatFrontmost: true };
  if (!s.chatFrontmost) return { ...s, chatFrontmost: true };
  return { ...s, lastVisible: s.chat, chat: "tucked", chatFrontmost: false };
}

// Compact always returns the bottom-docked input, exiting maximized/expanded
// coordinates. Never issues microphone/session operations.
export function compactChat(s: Presentation): Presentation {
  return { ...s, chat: "compact", lastVisible: "compact", chatFrontmost: true };
}
