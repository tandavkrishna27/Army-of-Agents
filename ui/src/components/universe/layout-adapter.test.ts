import {it, expect} from "vitest";
import {initialState, panelReducer, panelKey} from "./panel-state";
import {layoutEdit} from "./layout-adapter";
const scope = {companyId: "c", userId: "u", conversationId: "v"};
const ref = {companyId: "c", kind: "task" as const, id: "t"};
const rect = {x: 1, y: 2, width: 300, height: 200};
const opened = () => panelReducer(initialState(scope), {type: "open", ref, title: "Task", rect});
const key = panelKey(scope, ref);
it("records every new incarnation and its local generation alongside the open operation", () => {
 const before = initialState(scope); const after = opened(); const edit = layoutEdit(before, after);
 expect(edit.operations[0]).toEqual({type: "open", key, ref: {kind: "task", id: "t"}, title: "Task", rect});
 expect(edit.openings).toEqual([{operationIndex: 0, key, generation: 1}]);
 const closed = panelReducer(after, {type: "close", key, generation: 1});
 const reopened = panelReducer(closed, {type: "open", ref, title: "Task", rect});
 const replacement = layoutEdit(after, reopened);
 expect(replacement.operations.slice(0,2).map(op => op.type)).toEqual(["close", "open"]);
 expect(replacement.openings).toEqual([{operationIndex: 1, key, generation: 2}]);
});
it("persists only changed geometry and preserves atomic presentation", () => {
 const before = opened(); const moved = panelReducer(before, {type: "geometry", key, generation: 1, rect: {...rect, x: 20}, source: "human"});
 expect(layoutEdit(before, moved).operations).toEqual([{type: "geometry", key, rect: {...rect, x: 20}, placement: "manual"}]);
 const maximized = panelReducer(before, {type: "maximize", key, generation: 1});
 expect(layoutEdit(before, maximized).operations).toEqual([{type: "presentation", selected: key, maximized: key}]);
 expect(layoutEdit(before, before).operations).toEqual([]);
});
it("restores a hidden panel before maximizing and rejects cross-scope edits", () => {
 const before = panelReducer(opened(), {type: "minimize", key, generation: 1});
 const restored = panelReducer(before, {type: "restore", key, generation: 1});
 const after = panelReducer(restored, {type: "maximize", key, generation: 1});
 expect(layoutEdit(before, after).operations.map(op => op.type)).toEqual(["minimize", "order", "presentation"]);
 expect(() => layoutEdit(before, {...after, scope: {...scope, companyId: "other"}})).toThrow();
});

it("persists Arrange releasing manual placement even when geometry is unchanged", () => {
 const before = opened(); before.panels[key].placement = "manual";
 const after = panelReducer(before, {type: "arrange", rects: {[key]: rect}});
 expect(layoutEdit(before, after).operations).toEqual([{type: "geometry", key, rect, placement: "auto"}]);
});
