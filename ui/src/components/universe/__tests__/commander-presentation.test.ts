import { describe, it, expect } from "vitest";
import {
  toggleTrayChat,
  compactChat,
  initialPresentation,
  type Presentation,
} from "../commander-presentation";

const base = (over: Partial<Presentation> = {}): Presentation => ({
  chat: "compact",
  lastVisible: "compact",
  blob: true,
  captions: true,
  chatFrontmost: true,
  ...over,
});

describe("commander-presentation", () => {
  it("tray toggle preserves blob and captions (documented E1.5/3)", () => {
    const s = base();
    expect(toggleTrayChat(s)).toEqual({ ...s, chat: "tucked", chatFrontmost: false });
    expect(toggleTrayChat(toggleTrayChat(s))).toEqual(s);
  });

  it("compact exits maximized state (documented E1.5/3)", () => {
    const s = base({ chat: "maximized", lastVisible: "expanded", blob: false });
    expect(compactChat(s).chat).toBe("compact");
    expect(compactChat(s).blob).toBe(false);
  });

  it("brings a covered chat forward before tucking", () => {
    const covered = base({ chat: "expanded", lastVisible: "expanded", chatFrontmost: false });
    const forward = toggleTrayChat(covered);
    expect(forward).toEqual({ ...covered, chatFrontmost: true });
    expect(toggleTrayChat(forward).chat).toBe("tucked");
  });

  it("restores the last visible view from tucked", () => {
    const tucked = base({ chat: "tucked", lastVisible: "expanded", chatFrontmost: false });
    expect(toggleTrayChat(tucked)).toEqual({ ...tucked, chat: "expanded", chatFrontmost: true });
  });

  it("never changes blob/captions on toggle or compact", () => {
    const s = base({ chat: "expanded", lastVisible: "expanded", blob: false, captions: true });
    expect(toggleTrayChat(s).blob).toBe(false);
    expect(toggleTrayChat(s).captions).toBe(true);
    expect(compactChat(s).captions).toBe(true);
  });

  it("first-use defaults: compact chat, visible blob, captions off", () => {
    expect(initialPresentation()).toEqual({
      chat: "compact",
      lastVisible: "compact",
      blob: true,
      captions: false,
      chatFrontmost: true,
    });
  });
});
