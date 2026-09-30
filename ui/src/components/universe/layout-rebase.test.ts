import {it, expect} from "vitest";
import {emptyUniverseLayoutDocument, type LayoutOp} from "@armyofagents/shared";
import {captureWitnesses, canRebaseLayout} from "./layout-rebase";
const base = () => ({...emptyUniverseLayoutDocument(), panels: [{key: "p", ref: {companyId: "c", kind: "task" as const, id: "t"}, title: "Task", rect: {x: 0, y: 0, width: 300, height: 200}, openedOrdinal: 1, minimized: false, pinned: false}], order: ["p"], nextOpenedOrdinal: 2});
const move: LayoutOp = {type: "geometry", key: "p", rect: {x: 25, y: 0, width: 300, height: 200}};
it("rebases geometry across an independent pin change", () => {
 const doc = base(); const remote = structuredClone(doc); remote.panels[0]!.pinned = true;
 expect(canRebaseLayout([move], captureWitnesses(doc, [move]), remote)).toBe(true);
});
it("rejects same-property changes, close/reopen and hidden geometry", () => {
 for (const mutate of [(d: ReturnType<typeof base>) => {d.panels[0]!.rect.x = 10;}, (d: ReturnType<typeof base>) => {d.panels[0]!.openedOrdinal = 2; d.nextOpenedOrdinal = 3;}, (d: ReturnType<typeof base>) => {d.panels[0]!.minimized = true;}]) {
  const doc = base(); const remote = structuredClone(doc); mutate(remote);
  expect(canRebaseLayout([move], captureWitnesses(doc, [move]), remote)).toBe(false);
 }
});
it("never guesses for legacy journals or lifecycle operations", () => {
 const doc = base();
 expect(canRebaseLayout([move], undefined, doc)).toBe(false);
 const close: LayoutOp = {type: "close", key: "p"};
 expect(canRebaseLayout([close], captureWitnesses(doc, [close]), doc)).toBe(false);
});
it("compares the entire atomic group before allowing rebase", () => {
 const doc = base(); const ops: LayoutOp[] = [move, {type: "pin", key: "p", value: true}];
 const remote = structuredClone(doc); remote.panels[0]!.pinned = true;
 expect(canRebaseLayout(ops, captureWitnesses(doc, ops), remote)).toBe(false);
});

it("couples camera rebase to maximize state and presentation to camera", () => {
 const doc = base(); const remote = {...doc, selected: "p", maximized: "p"};
 const camera: LayoutOp = {type: "viewport", x: 10, y: 20, zoom: 1};
 expect(canRebaseLayout([camera], captureWitnesses(doc, [camera]), remote)).toBe(false);
 const present: LayoutOp = {type: "presentation", selected: "p", maximized: "p"};
 expect(canRebaseLayout([present], captureWitnesses(doc, [present]), {...doc, viewport: {x: 9, y: 0, zoom: 1}})).toBe(false);
});
