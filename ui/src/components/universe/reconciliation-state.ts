export type ReconciliationStatus = "loading" | "current" | "stale" | "offline";
export type ReconciliationState = {
  generation: number;
  lastSeq: number;
  status: ReconciliationStatus;
  dirtyRefs: string[];
};
export type EventHint = { seq?: number; referenceKey: string };

export function acceptHint(state: ReconciliationState, hint: EventHint): ReconciliationState {
  if (hint.seq !== undefined && hint.seq <= state.lastSeq) return state;
  return {
    ...state,
    lastSeq: hint.seq ?? state.lastSeq,
    status: "stale",
    dirtyRefs: state.dirtyRefs.includes(hint.referenceKey)
      ? state.dirtyRefs
      : [...state.dirtyRefs, hint.referenceKey],
  };
}

export function acceptSnapshot(state: ReconciliationState, currentSeq: number): ReconciliationState {
  return { ...state, lastSeq: Math.max(state.lastSeq, currentSeq), status: "current", dirtyRefs: [] };
}
