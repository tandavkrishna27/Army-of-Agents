// Pure tray state machine for E1.4/1 (icon tray + menus). One popup owner: at
// most one menu is open at a time. `manualCollapse` records that the user
// deliberately collapsed the tray, so an auto-hide reveal must wait for a genuine
// pointer exit/re-entry (reenter) before it can expand again.

export type TrayMenu =
  | "commander"
  | "work"
  | "artifacts"
  | "inbox"
  | "browser"
  | "settings"
  | "open-panels";

export type TrayState = {
  expanded: boolean;
  menu: TrayMenu | null;
  manualCollapse: boolean;
};

export type TrayAction =
  | { type: "logo" }
  | { type: "menu"; menu: TrayMenu }
  | { type: "dismiss" }
  | { type: "reenter" }
  | { type: "pointerEnter" }
  | { type: "pointerLeave" };

export const initialTrayState = (expanded = true): TrayState => ({
  expanded,
  menu: null,
  manualCollapse: false,
});

export function trayReducer(s: TrayState, a: TrayAction): TrayState {
  if (a.type === "logo")
    return { expanded: !s.expanded, menu: null, manualCollapse: s.expanded };
  if (a.type === "menu")
    return {
      expanded: true,
      menu: s.menu === a.menu ? null : a.menu,
      manualCollapse: false,
    };
  if (a.type === "dismiss") return { ...s, menu: null };
  if (a.type === "pointerEnter") return s.manualCollapse ? s : { ...s, expanded: true };
  if (a.type === "pointerLeave") return { expanded: false, menu: null, manualCollapse: false };
  // reenter: a genuine pointer exit/re-entry clears the manual-collapse latch.
  return { ...s, manualCollapse: false };
}
