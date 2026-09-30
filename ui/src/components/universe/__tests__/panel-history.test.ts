import { expect, it } from "vitest";
import { initialState, panelReducer, panelKey } from "../panel-state";
import {
  initialHistory,
  commitGesture,
  undoGeometry,
  redoGeometry,
  scopeKey,
} from "../panel-history";
const scope = { companyId: "c", userId: "u", conversationId: "chat" };
const ref = { companyId: "c", kind: "task" as const, id: "a" };
const key = panelKey(scope, ref);
const before = { x: 0, y: 0, width: 640, height: 480 };
const after = { ...before, x: 100 };
const entry = {
  scopeKey: scopeKey(scope),
  gestureId: "drag",
  key,
  generation: 1,
  before,
  after,
  source: "human" as const,
};
const moved = () =>
  panelReducer(initialState(scope), {
    type: "open",
    ref,
    title: "A",
    rect: after,
  });
it("one completed gesture yields one undo proposal, redo and duplicate receipt is inert", () => {
  const h = commitGesture(initialHistory(scope), entry);
  expect(commitGesture(h, entry)).toBe(h);
  const result = undoGeometry(moved(), h);
  expect(result.action).toMatchObject({
    type: "geometry",
    rect: before,
    generation: 1,
  });
  expect(h.undo).toHaveLength(1);
  expect(result.history.undo).toHaveLength(0);
  const s = panelReducer(moved(), result.action!);
  expect(redoGeometry(s, result.history).action?.rect).toEqual(after);
});
it("no-op/canceled gestures do not commit and new drag clears redo", () => {
  const h = initialHistory(scope);
  expect(commitGesture(h, { ...entry, after: before })).toBe(h);
  expect(commitGesture(h, { ...entry, cancelled: true })).toBe(h);
  const undone = undoGeometry(moved(), commitGesture(h, entry));
  expect(
    commitGesture(undone.history, { ...entry, gestureId: "next" }).redo
  ).toEqual([]);
});
it("bounds combined storage to 50 and clears on scope switch", () => {
  let h = initialHistory(scope);
  for (let n = 0; n < 51; n++)
    h = commitGesture(h, { ...entry, gestureId: String(n) });
  expect(h.undo).toHaveLength(50);
  expect(h.undo[0].gestureId).toBe("1");
  const result = undoGeometry(initialState({ ...scope, userId: "other" }), h);
  expect(result.history.undo).toEqual([]);
  expect(result.action).toBeNull();
});
it("remote geometry conflict retains candidate and cannot overwrite", () => {
  const h = commitGesture(initialHistory(scope), entry);
  const s = panelReducer(moved(), {
    type: "geometry",
    key,
    generation: 1,
    rect: { ...after, x: 300 },
    source: "human",
  });
  const r = undoGeometry(s, h);
  expect(r.action).toBeNull();
  expect(r.reason).toBe("geometry-conflict");
  expect(r.history).toBe(h);
});
it("generation, presentation and commander permissions fence replay", () => {
  const h = commitGesture(initialHistory(scope), entry);
  let s = moved();
  for (const type of ["minimize", "maximize", "close"] as const)
    expect(
      undoGeometry(panelReducer(s, { type, key, generation: 1 }), h).action
    ).toBeNull();
  s = panelReducer(s, { type: "close", key, generation: 1 });
  s = panelReducer(s, { type: "open", ref, title: "A", rect: after });
  expect(undoGeometry(s, h).action).toBeNull();
  const pinned = panelReducer(moved(), {
    type: "pin",
    key,
    generation: 1,
    value: true,
  });
  expect(undoGeometry(pinned, h).action).not.toBeNull();
  const commander = commitGesture(initialHistory(scope), {
    ...entry,
    source: "commander",
  });
  expect(
    undoGeometry(pinned, commander, { commanderAllowed: true }).action
  ).toBeNull();
  expect(undoGeometry(moved(), commander).action).toBeNull();
  expect(
    undoGeometry(moved(), commander, { commanderAllowed: true }).action
  ).not.toBeNull();
});
it("proposal rechecks expected rect at dispatch after an intervening remote edit", () => {
  const h = commitGesture(initialHistory(scope), entry);
  const proposed = undoGeometry(moved(), h);
  const remote = panelReducer(moved(), {
    type: "geometry",
    key,
    generation: 1,
    rect: { ...after, x: 400 },
    source: "human",
  });
  expect(panelReducer(remote, proposed.action!)).toBe(remote);
});
it("committed history copies caller rectangles", () => {
  const e = { ...entry, before: { ...before }, after: { ...after } };
  const h = commitGesture(initialHistory(scope), e);
  e.before.x = 99;
  e.after.x = 999;
  expect(undoGeometry(moved(), h).action?.rect).toEqual(before);
});
