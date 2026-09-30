import { describe, expect, it } from "vitest";
import {
  layoutPatchSchema,
  layoutOpSchema,
  rectSchema,
  universeLayoutDocumentSchema,
  emptyUniverseLayoutDocument,
  UNIVERSE_LAYOUT_MAX_OPERATIONS,
  UNIVERSE_LAYOUT_MAX_ZOOM,
} from "../validators/universe-layout.js";

const rect = { x: 10, y: 20, width: 300, height: 200 };

describe("universe layout validators", () => {
  it("accepts a well-formed patch covering every operation kind", () => {
    const patch = {
      schemaVersion: 1,
      operationId: "op-1",
      expectedRevision: 0,
      operations: [
        {
          type: "open",
          key: "k1",
          ref: { kind: "task", id: "t1" },
          rect,
          title: "T1",
        },
        { type: "geometry", key: "k1", rect },
        { type: "pin", key: "k1", value: true },
        { type: "minimize", key: "k1", value: false },
        { type: "order", keys: ["k1", "k2"] },
        { type: "viewport", x: 5, y: 6, zoom: 1 },
        { type: "close", key: "k1" },
      ],
    };
    expect(layoutPatchSchema.safeParse(patch).success).toBe(true);
  });

  it("rejects unknown ops, extra keys, bad kinds and out-of-range geometry", () => {
    expect(layoutOpSchema.safeParse({ type: "resize", key: "k" }).success).toBe(
      false
    );
    expect(
      layoutOpSchema.safeParse({ type: "pin", key: "k", value: true, extra: 1 })
        .success
    ).toBe(false);
    expect(rectSchema.safeParse({ ...rect, width: 0 }).success).toBe(false);
    expect(rectSchema.safeParse({ ...rect, x: Infinity }).success).toBe(false);
    expect(
      layoutOpSchema.safeParse({
        type: "viewport",
        x: 0,
        y: 0,
        zoom: UNIVERSE_LAYOUT_MAX_ZOOM + 1,
      }).success
    ).toBe(false);
    expect(
      layoutOpSchema.safeParse({
        type: "open",
        key: "k",
        ref: { kind: "evil", id: "x" },
        rect,
        title: "T",
      }).success
    ).toBe(false);
  });

  it("rejects an empty/oversized batch and a wrong schemaVersion", () => {
    const base = { schemaVersion: 1, operationId: "op", expectedRevision: 0 };
    expect(
      layoutPatchSchema.safeParse({ ...base, operations: [] }).success
    ).toBe(false);
    const many = Array.from({ length: UNIVERSE_LAYOUT_MAX_OPERATIONS + 1 }, () => ({
      type: "close",
      key: "k",
    }));
    expect(
      layoutPatchSchema.safeParse({ ...base, operations: many }).success
    ).toBe(false);
    expect(
      layoutPatchSchema.safeParse({
        ...base,
        schemaVersion: 2,
        operations: [{ type: "close", key: "k" }],
      }).success
    ).toBe(false);
  });

  it("validates the empty document and a populated one", () => {
    expect(
      universeLayoutDocumentSchema.safeParse(emptyUniverseLayoutDocument())
        .success
    ).toBe(true);
    const populated = {
      ...emptyUniverseLayoutDocument(),
      nextOpenedOrdinal: 2,
      panels: [
        {
          key: "k1",
          ref: { companyId: "c", kind: "task", id: "t1" },
          title: "T",
          rect,
          openedOrdinal: 1,
          minimized: false,
          pinned: false,
          placement: "auto",
        },
      ],
      order: ["k1"],
    };
    expect(universeLayoutDocumentSchema.safeParse(populated).success).toBe(true);
  });
  it("accepts explicit presentation and rejects unsafe revisions", () => {
    expect(layoutOpSchema.safeParse({ type: "presentation", selected: "k1", maximized: "k1" }).success).toBe(true);
    expect(layoutPatchSchema.safeParse({ schemaVersion: 1, operationId: "op", expectedRevision: Number.MAX_SAFE_INTEGER + 1, operations: [{ type: "close", key: "k" }] }).success).toBe(false);
  });

  it("rejects inconsistent persisted selection, order and ordinals", () => {
    const doc = { ...emptyUniverseLayoutDocument(), nextOpenedOrdinal: 2, panels: [{ key: "k1", ref: { companyId: "c", kind: "task", id: "t1" }, title: "T", rect, openedOrdinal: 1, minimized: false, pinned: false }], order: ["k1"] };
    for (const invalid of [
      { ...doc, order: [] }, { ...doc, order: ["k1", "k1"] },
      { ...doc, selected: "foreign" }, { ...doc, maximized: "k1" },
      { ...doc, selected: "k1", panels: [{ ...doc.panels[0], minimized: true }] },
      { ...doc, nextOpenedOrdinal: 1 },
      { ...doc, panels: [...doc.panels, doc.panels[0]] },
    ]) expect(universeLayoutDocumentSchema.safeParse(invalid).success).toBe(false);
  });

});

it("checkpoint state rejects executable fields and oversized state", async () => {
  const { checkpointPatchSchema } = await import("../validators/universe-layout.js");
  const valid = { sourceVersionId: "11111111-1111-4111-8111-111111111111", schemaVersion: 1, expectedRevision: 0,
    data: { inputs: { quantity: 2 }, selectedRows: [0], filters: {} } };
  expect(checkpointPatchSchema.safeParse(valid).success).toBe(true);
  expect(checkpointPatchSchema.safeParse({ ...valid, data: { ...valid.data, onClick: "run()" } }).success).toBe(false);
  expect(checkpointPatchSchema.safeParse({ ...valid, schemaVersion: 2 }).success).toBe(false);
  expect(checkpointPatchSchema.safeParse({ ...valid, data: { ...valid.data, inputs: { x: "x".repeat(33000) } } }).success).toBe(false);
});

it("enforces serialized UTF-8 patch budget in addition to operation count", () => {
  const operations = Array.from({length: 40}, (_, i) => ({ type: "open", key: `${i}` + "x".repeat(900),
    ref: {kind: "task", id: "task"}, title: "é".repeat(900), rect: {x: 0, y: 0, width: 300, height: 200} }));
  expect(layoutPatchSchema.safeParse({schemaVersion: 1, operationId: "budget", expectedRevision: 0, operations}).success).toBe(false);
});

it("rejects an otherwise valid snapshot above 256 KiB", () => {
  const panels = Array.from({length: 130}, (_, i) => ({ key: `${i}`, ref: {companyId: "c", kind: "task", id: `${i}`},
    title: "é".repeat(1024), rect: {x: 0, y: 0, width: 300, height: 200}, openedOrdinal: i + 1, minimized: false, pinned: false }));
  expect(universeLayoutDocumentSchema.safeParse({ ...emptyUniverseLayoutDocument(), panels, order: panels.map(p => p.key), nextOpenedOrdinal: 131 }).success).toBe(false);
});
