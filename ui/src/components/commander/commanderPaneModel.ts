export interface CommanderDiscussionSelection {
  id: string;
  title: string;
}

export interface CommanderPaneSnapshot {
  sessionsCollapsed: boolean;
  cockpitCollapsed: boolean;
  viewerCollapsed: boolean;
}

export interface CommanderPaneState {
  discussion: CommanderDiscussionSelection | null;
  nestedDetailOpen: boolean;
  restoreSnapshot: CommanderPaneSnapshot | null;
}

export type CommanderPaneAction =
  | {
      type: "open_discussion";
      discussion: CommanderDiscussionSelection;
      snapshot: CommanderPaneSnapshot;
    }
  | { type: "close_discussion" }
  | { type: "open_nested_detail" }
  | { type: "close_nested_detail" };

export const initialCommanderPaneState: CommanderPaneState = {
  discussion: null,
  nestedDetailOpen: false,
  restoreSnapshot: null,
};

export function commanderPaneReducer(
  state: CommanderPaneState,
  action: CommanderPaneAction,
): CommanderPaneState {
  switch (action.type) {
    case "open_discussion":
      return {
        discussion: action.discussion,
        nestedDetailOpen: false,
        restoreSnapshot: state.discussion ? state.restoreSnapshot : action.snapshot,
      };
    case "close_discussion":
      return initialCommanderPaneState;
    case "open_nested_detail":
      return state.discussion ? { ...state, nestedDetailOpen: true } : state;
    case "close_nested_detail":
      return state.nestedDetailOpen ? { ...state, nestedDetailOpen: false } : state;
  }
}
