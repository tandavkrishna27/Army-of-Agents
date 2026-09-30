import type {LayoutOp, UniverseLayoutDocument} from "@armyofagents/shared";
import {equalRect, sameScope, type State, type Viewport} from "./panel-state";

export type LayoutEditContext = {epoch: string; openings: LocalOpening[]};
export type LocalOpening = {operationIndex: number; key: string; generation: number};
/** Translate an accepted controller edit, never a measured display rectangle.
 * Presentation is explicit after lifecycle effects, so all fields commit together. */
export function layoutEdit(before: State, after: State): {operations: LayoutOp[]; openings: LocalOpening[]} {
  if (!sameScope(before.scope, after.scope)) throw new Error("Cannot persist a cross-scope edit");
  const operations: LayoutOp[] = [];
  const openings: LocalOpening[] = [];
  let lifecycle = false;
  for (const key of before.order) {
    if (!after.panels[key] || before.panels[key].generation !== after.panels[key].generation) {
      operations.push({type: "close", key}); lifecycle = true;
    }
  }
  for (const key of after.order) {
    const panel = after.panels[key];
    const old = before.panels[key];
    const fresh = !old || old.generation !== panel.generation;
    if (fresh) {
      const {kind, id, version} = panel.ref;
      openings.push({operationIndex: operations.length, key, generation: panel.generation});
      operations.push({type: "open", key, ref: {kind, id, ...(version === undefined ? {} : {version})}, title: panel.title, rect: {...panel.rect}});
      lifecycle = true;
    } else {
      if (old.minimized && !panel.minimized) {
        operations.push({type: "minimize", key, value: false}); lifecycle = true;
      }
      if (!equalRect(old.rect, panel.rect) || old.placement !== panel.placement) operations.push({type: "geometry", key, rect: {...panel.rect}, ...(panel.placement ? {placement: panel.placement} : {})});
    }
    if ((fresh && panel.pinned) || (!fresh && old.pinned !== panel.pinned)) operations.push({type: "pin", key, value: panel.pinned});
    if (panel.minimized && (fresh || !old.minimized)) {
      operations.push({type: "minimize", key, value: true}); lifecycle = true;
    }
  }
  if (lifecycle || JSON.stringify(before.order) !== JSON.stringify(after.order)) operations.push({type: "order", keys: [...after.order]});
  if (lifecycle || before.selected !== after.selected || before.maximized !== after.maximized)
    operations.push({type: "presentation", selected: after.selected, maximized: after.maximized});
  return {operations, openings};
}

export function documentFromState(state: State, viewport: Viewport): UniverseLayoutDocument {
 return {panels: state.order.map(key => {
   const {generation: _generation, ...panel} = state.panels[key];
   return {...panel, ref: {...panel.ref}, rect: {...panel.rect}};
 }), order: [...state.order], selected: state.selected, maximized: state.maximized,
 viewport: {...viewport}, nextOpenedOrdinal: state.nextOpenedOrdinal};
}
