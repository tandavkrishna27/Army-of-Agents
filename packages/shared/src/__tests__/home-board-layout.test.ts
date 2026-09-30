import { describe, it, expect } from "vitest";
import {
  validateHomeBoardLayout,
  updateHomeBoardLayoutSchema,
} from "../validators/home-board-layout.js";
import type { HomeBoardLayoutItem } from "../home-board.js";

/**
 * A full, valid 8-widget board — one instance of every widget, packed into
 * the 4-col lg grid with no overlaps, each at one of its allowed sizes.
 */
const VALID_FULL_LAYOUT: HomeBoardLayoutItem[] = [
  { i: "agents-now", x: 0, y: 0, w: 1, h: 1 },
  { i: "budget", x: 1, y: 0, w: 1, h: 1 },
  // approvals ("Waiting on you") is now a list widget (Plan 7 Task 5): its
  // allowed sizes dropped 1×1, so this fixture uses its 2×1 compact size.
  // NOT 2×2 — a 2×2 footprint here (h:2 at cols 2-3) would overlap
  // suggestions at (2,1,2,1) below.
  { i: "approvals", x: 2, y: 0, w: 2, h: 1 },
  { i: "action-queue", x: 0, y: 1, w: 2, h: 1 },
  { i: "suggestions", x: 2, y: 1, w: 2, h: 1 },
  { i: "objectives", x: 0, y: 2, w: 2, h: 2 },
  { i: "my-tasks", x: 2, y: 2, w: 2, h: 2 },
  { i: "activity-feed", x: 0, y: 4, w: 4, h: 2 },
];

describe("validateHomeBoardLayout (pure)", () => {
  it("passes a valid, full 8-widget layout", () => {
    expect(validateHomeBoardLayout(VALID_FULL_LAYOUT)).toEqual({ ok: true });
  });

  it("passes an empty layout", () => {
    expect(validateHomeBoardLayout([])).toEqual({ ok: true });
  });

  it("passes a single-widget layout", () => {
    expect(validateHomeBoardLayout([{ i: "budget", x: 0, y: 0, w: 1, h: 1 }])).toEqual({ ok: true });
  });

  it("rejects a footprint not in the widget's allowed sizes", () => {
    // agents-now only allows {1,1} and {2,1} — {2,2} is in-bounds but disallowed.
    const result = validateHomeBoardLayout([{ i: "agents-now", x: 0, y: 0, w: 2, h: 2 }]);
    expect(result.ok).toBe(false);
  });

  it("rejects x+w exceeding the 4-column grid", () => {
    // action-queue's {2,1} is an allowed size, but x:3 pushes it out of bounds.
    const result = validateHomeBoardLayout([{ i: "action-queue", x: 3, y: 0, w: 2, h: 1 }]);
    expect(result.ok).toBe(false);
  });

  it("rejects y+h exceeding HOME_BOARD_MAX_ROWS", () => {
    const result = validateHomeBoardLayout([{ i: "budget", x: 0, y: 49, w: 1, h: 2 }]);
    expect(result.ok).toBe(false);
  });

  it("rejects overlapping items", () => {
    const result = validateHomeBoardLayout([
      { i: "agents-now", x: 0, y: 0, w: 1, h: 1 },
      { i: "budget", x: 0, y: 0, w: 1, h: 1 },
    ]);
    expect(result.ok).toBe(false);
  });

  it("does not flag adjacent (edge-touching, non-overlapping) items", () => {
    const result = validateHomeBoardLayout([
      { i: "agents-now", x: 0, y: 0, w: 1, h: 1 },
      { i: "budget", x: 1, y: 0, w: 1, h: 1 },
    ]);
    expect(result).toEqual({ ok: true });
  });

  it("rejects a duplicate widget key", () => {
    const result = validateHomeBoardLayout([
      { i: "agents-now", x: 0, y: 0, w: 1, h: 1 },
      { i: "agents-now", x: 1, y: 0, w: 1, h: 1 },
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown widget key", () => {
    const result = validateHomeBoardLayout([{ i: "not-a-real-widget", x: 0, y: 0, w: 1, h: 1 }]);
    expect(result.ok).toBe(false);
  });

  it("rejects more than HOME_BOARD_MAX_ITEMS entries", () => {
    const nineItems = [
      ...VALID_FULL_LAYOUT,
      { i: "budget", x: 0, y: 6, w: 1, h: 1 },
    ] as HomeBoardLayoutItem[];
    const result = validateHomeBoardLayout(nineItems);
    expect(result.ok).toBe(false);
  });

  it("rejects negative coordinates", () => {
    expect(validateHomeBoardLayout([{ i: "budget", x: -1, y: 0, w: 1, h: 1 }]).ok).toBe(false);
    expect(validateHomeBoardLayout([{ i: "budget", x: 0, y: -1, w: 1, h: 1 }]).ok).toBe(false);
  });
});

describe("updateHomeBoardLayoutSchema (wire contract)", () => {
  it("accepts a valid full layout wrapped in { layout }", () => {
    const result = updateHomeBoardLayoutSchema.safeParse({ layout: VALID_FULL_LAYOUT });
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });

  it("accepts an empty layout", () => {
    expect(updateHomeBoardLayoutSchema.safeParse({ layout: [] }).success).toBe(true);
  });

  it("rejects a disallowed size", () => {
    const result = updateHomeBoardLayoutSchema.safeParse({
      layout: [{ i: "agents-now", x: 0, y: 0, w: 2, h: 2 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects x+w out of bounds", () => {
    const result = updateHomeBoardLayoutSchema.safeParse({
      layout: [{ i: "action-queue", x: 3, y: 0, w: 2, h: 1 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects overlapping items", () => {
    const result = updateHomeBoardLayoutSchema.safeParse({
      layout: [
        { i: "agents-now", x: 0, y: 0, w: 1, h: 1 },
        { i: "budget", x: 0, y: 0, w: 1, h: 1 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a duplicate widget key", () => {
    const result = updateHomeBoardLayoutSchema.safeParse({
      layout: [
        { i: "agents-now", x: 0, y: 0, w: 1, h: 1 },
        { i: "agents-now", x: 1, y: 0, w: 1, h: 1 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown widget key", () => {
    const result = updateHomeBoardLayoutSchema.safeParse({
      layout: [{ i: "not-a-real-widget", x: 0, y: 0, w: 1, h: 1 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than HOME_BOARD_MAX_ITEMS entries", () => {
    const nineItems = [
      ...VALID_FULL_LAYOUT,
      { i: "budget", x: 0, y: 6, w: 1, h: 1 },
    ];
    const result = updateHomeBoardLayoutSchema.safeParse({ layout: nineItems });
    expect(result.success).toBe(false);
  });

  it("rejects negative coordinates", () => {
    const result = updateHomeBoardLayoutSchema.safeParse({
      layout: [{ i: "budget", x: -1, y: 0, w: 1, h: 1 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer coordinate", () => {
    const result = updateHomeBoardLayoutSchema.safeParse({
      layout: [{ i: "budget", x: 0.5, y: 0, w: 1, h: 1 }],
    });
    expect(result.success).toBe(false);
  });

  it("is strict: rejects a client-supplied schemaVersion", () => {
    const result = updateHomeBoardLayoutSchema.safeParse({
      layout: VALID_FULL_LAYOUT,
      schemaVersion: 1,
    });
    expect(result.success).toBe(false);
  });

  it("is strict: rejects a client-supplied userId", () => {
    const result = updateHomeBoardLayoutSchema.safeParse({
      layout: VALID_FULL_LAYOUT,
      userId: "someone-else",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing layout field", () => {
    expect(updateHomeBoardLayoutSchema.safeParse({}).success).toBe(false);
  });
});
