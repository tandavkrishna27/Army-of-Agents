import { describe, expect, it } from "vitest";
import {
  applyLayoutOp,
  applyLayoutWithOpenings,
  applyLayoutOperations,
  hashLayoutOperations,
  type UniverseScope,
} from "../services/universe-layout-document.js";
import {
  emptyUniverseLayoutDocument,
  type LayoutOp,
} from "@armyofagents/shared";

const scope: UniverseScope = {
  companyId: "c1",
  userId: "u1",
  conversationId: "conv1",
};
const rect = { x: 0, y: 0, width: 300, height: 200 };
const openOp = (key: string): LayoutOp => ({
  type: "open",
  key,
  ref: { kind: "task", id: key },
  rect,
  title: key,
});

describe("universe layout reducer", () => {
  it("open creates a panel, foregrounds it and increments the ordinal", () => {
    const doc = applyLayoutOp(
      emptyUniverseLayoutDocument(),
      openOp("k1"),
      scope,
    );
    expect(doc.panels).toHaveLength(1);
    expect(doc.panels[0]).toMatchObject({
      key: "k1",
      ref: { companyId: "c1", kind: "task", id: "k1" },
      openedOrdinal: 1,
      placement: "auto",
    });
    expect(doc.order).toEqual(["k1"]);
    expect(doc.selected).toBe("k1");
    expect(doc.nextOpenedOrdinal).toBe(2);
  });

  it("re-opening un-minimizes and foregrounds without duplicating", () => {
    let doc = applyLayoutOperations(
      emptyUniverseLayoutDocument(),
      [openOp("k1"), openOp("k2")],
      scope,
    );
    doc = applyLayoutOp(doc, { type: "minimize", key: "k1", value: true }, scope);
    expect(doc.panels.find((p) => p.key === "k1")!.minimized).toBe(true);
    doc = applyLayoutOp(doc, openOp("k1"), scope);
    expect(doc.panels).toHaveLength(2);
    expect(doc.panels.find((p) => p.key === "k1")!.minimized).toBe(false);
    expect(doc.order.at(-1)).toBe("k1");
    expect(doc.selected).toBe("k1");
  });

  it("geometry, pin, minimize and close on an unknown panel are rejected", () => {
    const doc = emptyUniverseLayoutDocument();
    for (const op of [
      { type: "geometry", key: "x", rect },
      { type: "pin", key: "x", value: true },
      { type: "minimize", key: "x", value: true },
      { type: "close", key: "x" },
    ] as LayoutOp[])
      expect(() => applyLayoutOp(doc, op, scope)).toThrow();
  });

  it("close removes the panel and selects the last visible survivor", () => {
    let doc = applyLayoutOperations(
      emptyUniverseLayoutDocument(),
      [openOp("k1"), openOp("k2")],
      scope,
    );
    doc = applyLayoutOp(doc, { type: "close", key: "k2" }, scope);
    expect(doc.panels.map((p) => p.key)).toEqual(["k1"]);
    expect(doc.order).toEqual(["k1"]);
    expect(doc.selected).toBe("k1");
  });

  it("order must be an exact permutation of the open panels", () => {
    const doc = applyLayoutOperations(
      emptyUniverseLayoutDocument(),
      [openOp("k1"), openOp("k2")],
      scope,
    );
    expect(
      applyLayoutOp(doc, { type: "order", keys: ["k2", "k1"] }, scope).order,
    ).toEqual(["k2", "k1"]);
    for (const keys of [["k1"], ["k1", "k1"], ["k1", "x"]])
      expect(() =>
        applyLayoutOp(doc, { type: "order", keys }, scope),
      ).toThrow();
  });

  it("viewport updates the camera; hashing is stable and payload-sensitive", () => {
    const doc = applyLayoutOp(
      emptyUniverseLayoutDocument(),
      { type: "viewport", x: 5, y: 6, zoom: 2 },
      scope,
    );
    expect(doc.viewport).toEqual({ x: 5, y: 6, zoom: 2 });
    expect(hashLayoutOperations([openOp("k1")])).toBe(
      hashLayoutOperations([openOp("k1")]),
    );
    expect(hashLayoutOperations([openOp("k1")])).not.toBe(
      hashLayoutOperations([openOp("k2")]),
    );
  });
  it("maximizes and restores without changing normal geometry", () => {
    const doc = applyLayoutOperations(emptyUniverseLayoutDocument(), [openOp("k1"), { type: "presentation", selected: "k1", maximized: "k1" }], scope);
    expect(doc.maximized).toBe("k1");
    expect(() => applyLayoutOperations(doc, [{ type: "geometry", key: "k1", rect }], scope)).toThrow();
    const restored = applyLayoutOperations(doc, [{ type: "presentation", selected: "k1", maximized: null }], scope);
    expect(restored.panels[0].rect).toEqual(rect);
  });

  it("foreground restores and exits the other panel's maximize", () => {
    const doc = applyLayoutOperations(emptyUniverseLayoutDocument(), [openOp("k1"), openOp("k2"), { type: "minimize", key: "k1", value: true }, { type: "presentation", selected: "k2", maximized: "k2" }], scope);
    const restored = applyLayoutOperations(doc, [{ type: "minimize", key: "k1", value: false }], scope);
    expect(restored).toMatchObject({ selected: "k1", maximized: null, order: ["k2", "k1"] });
  });

  it("validates final presentation after a complete atomic batch", () => {
    const doc = applyLayoutOperations(emptyUniverseLayoutDocument(), [openOp("k1"), openOp("k2"), { type: "presentation", selected: "k2", maximized: "k2" }], scope);
    expect(() => applyLayoutOperations(doc, [{ type: "order", keys: ["k2", "k1"] }], scope)).toThrow();
    expect(applyLayoutOperations(doc, [{ type: "order", keys: ["k2", "k1"] }, { type: "presentation", selected: "k1", maximized: "k1" }], scope).maximized).toBe("k1");
  });

  it("minimizing transfers selection and protects hidden geometry", () => {
    const doc = applyLayoutOperations(emptyUniverseLayoutDocument(), [openOp("k1"), openOp("k2"), { type: "minimize", key: "k2", value: true }], scope);
    expect(doc.selected).toBe("k1");
    expect(() => applyLayoutOperations(doc, [{ type: "geometry", key: "k2", rect }], scope)).toThrow();
    expect(applyLayoutOperations(doc, [{ type: "minimize", key: "k1", value: true }], scope).selected).toBeNull();
  });

  it("does not allocate unsafe ordinals or mutate the input on an invalid batch", () => {
    const exhausted = { ...emptyUniverseLayoutDocument(), nextOpenedOrdinal: Number.MAX_SAFE_INTEGER };
    expect(() => applyLayoutOperations(exhausted, [openOp("k1")], scope)).toThrow();
    const doc = emptyUniverseLayoutDocument();
    expect(() => applyLayoutOperations(doc, [openOp("k1"), { type: "presentation", selected: "missing", maximized: null }], scope)).toThrow();
    expect(doc).toEqual(emptyUniverseLayoutDocument());
  });

  it("opening the already-maximized panel preserves its presentation and identity", () => {
    const doc = applyLayoutOperations(emptyUniverseLayoutDocument(), [openOp("k1"), { type: "presentation", selected: "k1", maximized: "k1" }], scope);
    const reopened = applyLayoutOperations(doc, [openOp("k1")], scope);
    expect(reopened.maximized).toBe("k1");
    expect(reopened.panels).toEqual(doc.panels);
    expect(reopened.nextOpenedOrdinal).toBe(doc.nextOpenedOrdinal);
  });

});

it("receipts preserve every open incarnation even when closed in the same batch", () => {
  const result = applyLayoutWithOpenings(emptyUniverseLayoutDocument(), [
    openOp("k1"), openOp("k1"), { type: "close", key: "k1" }, openOp("k1"),
  ], scope);
  expect(result.opened).toEqual([
    { operationIndex: 0, key: "k1", openedOrdinal: 1 },
    { operationIndex: 1, key: "k1", openedOrdinal: 1 },
    { operationIndex: 3, key: "k1", openedOrdinal: 2 },
  ]);
  expect(result.document.nextOpenedOrdinal).toBe(3);
});

it.each(["minimize", "close"] as const)("%s selected skips hidden survivors when choosing focus", type => {
 const doc = applyLayoutOperations(emptyUniverseLayoutDocument(), [openOp("k1"), openOp("k2"), {type: "minimize", key: "k2", value: true}, openOp("k3")], scope);
 const next = applyLayoutOperations(doc, [type === "close" ? {type, key: "k3"} : {type, key: "k3", value: true}], scope);
 expect(next.selected).toBe("k1");
});
