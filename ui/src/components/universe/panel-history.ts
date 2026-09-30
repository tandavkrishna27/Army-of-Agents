import {
  equalRect,
  positiveInteger,
  validRect,
  type Action,
  type Rect,
  type Scope,
  type State,
} from "./panel-state";
export type GestureEntry = {
  scopeKey: string;
  gestureId: string;
  key: string;
  generation: number;
  before: Rect;
  after: Rect;
  source: "human" | "commander";
  cancelled?: boolean;
};
export type History = {
  scopeKey: string;
  undo: readonly GestureEntry[];
  redo: readonly GestureEntry[];
};
export type GeometryAction = Extract<Action, { type: "geometry" }>;
export type HistoryResult = {
  action: GeometryAction | null;
  history: History;
  reason?:
    | "empty"
    | "scope-changed"
    | "generation-changed"
    | "not-visible"
    | "source-revoked"
    | "geometry-conflict";
};
export type ReplayPermission = { commanderAllowed?: boolean };
export const scopeKey = (scope: Scope): string =>
  JSON.stringify([scope.companyId, scope.userId, scope.conversationId]);
export const initialHistory = (scope: Scope): History => ({
  scopeKey: scopeKey(scope),
  undo: [],
  redo: [],
});
/** Call only on completed gestures. Cancelled/no-op gestures never clear redo. */
export function commitGesture(history: History, entry: GestureEntry): History {
  if (
    entry.cancelled ||
    entry.scopeKey !== history.scopeKey ||
    !entry.gestureId?.trim() ||
    !entry.key ||
    !positiveInteger(entry.generation) ||
    !validRect(entry.before) ||
    !validRect(entry.after) ||
    (entry.source !== "human" && entry.source !== "commander") ||
    equalRect(entry.before, entry.after) ||
    [...history.undo, ...history.redo].some(
      (e) => e.gestureId === entry.gestureId
    )
  )
    return history;
  return {
    ...history,
    undo: [
      ...history.undo,
      { ...entry, before: { ...entry.before }, after: { ...entry.after } },
    ].slice(-50),
    redo: [],
  };
}
function propose(
  state: State,
  history: History,
  direction: "undo" | "redo",
  permission: ReplayPermission
): HistoryResult {
  if (scopeKey(state.scope) !== history.scopeKey)
    return {
      action: null,
      history: initialHistory(state.scope),
      reason: "scope-changed",
    };
  const entries = history[direction];
  const entry = entries.at(-1);
  const rejected = (reason: HistoryResult["reason"]): HistoryResult => ({
    action: null,
    history,
    reason,
  });
  if (!entry) return rejected("empty");
  const panel = Object.hasOwn(state.panels, entry.key)
    ? state.panels[entry.key]
    : undefined;
  if (
    entry.scopeKey !== history.scopeKey ||
    !panel ||
    panel.generation !== entry.generation
  )
    return rejected("generation-changed");
  if (panel.minimized || state.maximized === entry.key)
    return rejected("not-visible");
  if (
    entry.source === "commander" &&
    (!permission.commanderAllowed || panel.pinned)
  )
    return rejected("source-revoked");
  const expected = direction === "undo" ? entry.after : entry.before;
  if (!equalRect(panel.rect, expected)) return rejected("geometry-conflict");
  const target = direction === "undo" ? entry.before : entry.after;
  const opposite = direction === "undo" ? "redo" : "undo";
  return {
    action: {
      type: "geometry",
      key: entry.key,
      generation: entry.generation,
      rect: { ...target },
      expectedRect: { ...expected },
      source: entry.source,
    },
    history: {
      ...history,
      [direction]: entries.slice(0, -1),
      [opposite]: [...history[opposite], entry],
    },
  };
}
/** Candidate only: install returned history after successful acceptance; retain original on CAS failure/lost ack. */
export const undoGeometry = (
  state: State,
  history: History,
  permission: ReplayPermission = {}
): HistoryResult => propose(state, history, "undo", permission);
export const redoGeometry = (
  state: State,
  history: History,
  permission: ReplayPermission = {}
): HistoryResult => propose(state, history, "redo", permission);
