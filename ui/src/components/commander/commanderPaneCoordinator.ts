export type CommanderBreakpoint = "mobile" | "tablet" | "desktop" | "wide";
export type CommanderPaneVisibility = "expanded" | "rail" | "hidden";

export const COMMANDER_INTERACTION_CONTRACT = {
  mobileMax: 720,
  tabletMax: 1099,
  desktopMax: 1599,
  minimumTouchTargetPx: 44,
  minimumMarkerTextPx: 11,
  maximumVisibleAttentionMarkers: 2,
  escapeOrder: ["cockpit_drawer", "viewer", "focus"] as const,
} as const;

export interface CommanderFocusTarget {
  kind: "workspace" | "discussion";
  entityId: string;
  title?: string;
  anchorId?: string;
}

export interface CommanderPaneLayoutSnapshot {
  chat: CommanderPaneVisibility;
  cockpit: CommanderPaneVisibility;
  originFocusKey: string | null;
}

export interface CommanderPaneCoordinatorState {
  breakpoint: CommanderBreakpoint;
  chat: CommanderPaneVisibility;
  focus: CommanderFocusTarget | null;
  viewerOpen: boolean;
  cockpit: CommanderPaneVisibility;
  cockpitDrawerOpen: boolean;
  restoreSnapshot: CommanderPaneLayoutSnapshot | null;
  viewerRestoreChat: CommanderPaneVisibility | null;
  originFocusKey: string | null;
}

export type CommanderPaneCoordinatorAction =
  | { type: "set_width"; width: number }
  | { type: "open_focus"; target: CommanderFocusTarget; originFocusKey: string }
  | { type: "close_focus" }
  | { type: "open_viewer"; originFocusKey: string }
  | { type: "close_viewer" }
  | { type: "open_cockpit_drawer" }
  | { type: "close_cockpit_drawer" }
  | { type: "escape" };

export function commanderBreakpoint(width: number): CommanderBreakpoint {
  if (width <= COMMANDER_INTERACTION_CONTRACT.mobileMax) return "mobile";
  if (width <= COMMANDER_INTERACTION_CONTRACT.tabletMax) return "tablet";
  if (width <= COMMANDER_INTERACTION_CONTRACT.desktopMax) return "desktop";
  return "wide";
}

function defaultCockpitVisibility(breakpoint: CommanderBreakpoint): CommanderPaneVisibility {
  return breakpoint === "wide" ? "expanded" : "rail";
}

export function initialCommanderPaneCoordinatorState(width: number): CommanderPaneCoordinatorState {
  const breakpoint = commanderBreakpoint(width);
  return {
    breakpoint,
    chat: "expanded",
    focus: null,
    viewerOpen: false,
    cockpit: defaultCockpitVisibility(breakpoint),
    cockpitDrawerOpen: false,
    restoreSnapshot: null,
    viewerRestoreChat: null,
    originFocusKey: null,
  };
}

function closeViewer(state: CommanderPaneCoordinatorState): CommanderPaneCoordinatorState {
  if (!state.viewerOpen) return state;
  return {
    ...state,
    viewerOpen: false,
    chat: state.viewerRestoreChat ?? state.chat,
    viewerRestoreChat: null,
  };
}

function closeFocus(state: CommanderPaneCoordinatorState): CommanderPaneCoordinatorState {
  if (!state.focus) return state;
  const snapshot = state.restoreSnapshot;
  return {
    ...state,
    chat: snapshot?.chat ?? "expanded",
    focus: null,
    viewerOpen: false,
    cockpit: snapshot?.cockpit ?? defaultCockpitVisibility(state.breakpoint),
    cockpitDrawerOpen: false,
    restoreSnapshot: null,
    viewerRestoreChat: null,
    originFocusKey: snapshot?.originFocusKey ?? null,
  };
}

export function commanderPaneCoordinatorReducer(
  state: CommanderPaneCoordinatorState,
  action: CommanderPaneCoordinatorAction,
): CommanderPaneCoordinatorState {
  switch (action.type) {
    case "set_width": {
      const breakpoint = commanderBreakpoint(action.width);
      if (breakpoint === state.breakpoint) return state;
      const chat = state.focus && (breakpoint === "tablet" || breakpoint === "mobile")
        ? "hidden"
        : state.viewerOpen && breakpoint === "wide"
          ? "rail"
          : "expanded";
      return {
        ...state,
        breakpoint,
        chat,
        cockpit: defaultCockpitVisibility(breakpoint),
        cockpitDrawerOpen: false,
      };
    }
    case "open_focus": {
      const restoreSnapshot = state.restoreSnapshot ?? {
        chat: state.chat,
        cockpit: state.cockpit,
        originFocusKey: state.originFocusKey,
      };
      const chat = state.breakpoint === "mobile" || state.breakpoint === "tablet"
        ? "hidden"
        : "expanded";
      return {
        ...state,
        chat,
        focus: action.target,
        viewerOpen: false,
        cockpitDrawerOpen: false,
        restoreSnapshot,
        viewerRestoreChat: null,
        originFocusKey: action.originFocusKey,
      };
    }
    case "close_focus":
      return closeFocus(state);
    case "open_viewer":
      return {
        ...state,
        chat: state.focus
          ? state.breakpoint === "wide" ? "rail" : "hidden"
          : state.breakpoint === "wide" ? "rail" : state.chat,
        viewerOpen: true,
        cockpitDrawerOpen: false,
        viewerRestoreChat: state.viewerOpen ? state.viewerRestoreChat : state.chat,
        originFocusKey: action.originFocusKey,
      };
    case "close_viewer":
      return closeViewer(state);
    case "open_cockpit_drawer":
      return { ...state, cockpitDrawerOpen: true };
    case "close_cockpit_drawer":
      return state.cockpitDrawerOpen ? { ...state, cockpitDrawerOpen: false } : state;
    case "escape":
      if (state.cockpitDrawerOpen) return { ...state, cockpitDrawerOpen: false };
      if (state.viewerOpen) return closeViewer(state);
      if (state.focus) return closeFocus(state);
      return state;
  }
}

export function commanderExpandedWorkSurfaceCount(state: CommanderPaneCoordinatorState): number {
  return Number(state.chat === "expanded") + Number(state.focus !== null) + Number(state.viewerOpen);
}
