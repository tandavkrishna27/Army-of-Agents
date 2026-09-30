import { describe, expect, it } from "vitest";
import { trayReducer, initialTrayState, type TrayState } from "../tray-state";

const open = (menu: TrayState["menu"]): TrayState => ({
  expanded: true,
  menu,
  manualCollapse: false,
});

describe("trayReducer", () => {
  it("opening one menu then another replaces it (only one open at a time)", () => {
    const s = trayReducer(open("work"), { type: "menu", menu: "inbox" });
    expect(s.menu).toBe("inbox");
    expect(s.expanded).toBe(true);
  });

  it("toggling the same menu closes it", () => {
    expect(trayReducer(open("work"), { type: "menu", menu: "work" }).menu).toBeNull();
  });

  it("opening a menu expands the tray and clears manual collapse", () => {
    const collapsed: TrayState = { expanded: false, menu: null, manualCollapse: true };
    const s = trayReducer(collapsed, { type: "menu", menu: "commander" });
    expect(s).toEqual({ expanded: true, menu: "commander", manualCollapse: false });
  });

  it("the logo collapses an expanded tray, dismisses menus and latches manual collapse", () => {
    expect(trayReducer(open("work"), { type: "logo" })).toEqual({
      expanded: false,
      menu: null,
      manualCollapse: true,
    });
  });

  it("the logo re-expands a collapsed tray without latching", () => {
    const collapsed: TrayState = { expanded: false, menu: null, manualCollapse: true };
    expect(trayReducer(collapsed, { type: "logo" })).toEqual({
      expanded: true,
      menu: null,
      manualCollapse: false,
    });
  });

  it("dismiss closes the menu but keeps expansion and the collapse latch", () => {
    const s: TrayState = { expanded: true, menu: "inbox", manualCollapse: true };
    expect(trayReducer(s, { type: "dismiss" })).toEqual({
      expanded: true,
      menu: null,
      manualCollapse: true,
    });
  });

  it("reenter clears the manual-collapse latch so auto-hide reveal can resume", () => {
    const collapsed: TrayState = { expanded: false, menu: null, manualCollapse: true };
    expect(trayReducer(collapsed, { type: "reenter" })).toEqual({
      expanded: false,
      menu: null,
      manualCollapse: false,
    });
  });

  it("defaults to expanded, no menu, not manually collapsed", () => {
    expect(initialTrayState()).toEqual({
      expanded: true,
      menu: null,
      manualCollapse: false,
    });
  });

  it("auto-hide waits for a real pointer leave after manual collapse", () => {
    const collapsed = trayReducer(initialTrayState(), { type: "logo" });
    expect(trayReducer(collapsed, { type: "pointerEnter" })).toEqual(collapsed);
    const left = trayReducer(collapsed, { type: "pointerLeave" });
    expect(left).toEqual({ expanded: false, menu: null, manualCollapse: false });
    expect(trayReducer(left, { type: "pointerEnter" }).expanded).toBe(true);
  });
});
