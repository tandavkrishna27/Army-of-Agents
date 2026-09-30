import { z } from "zod";
import {
  HOME_BOARD_WIDGET_KEYS,
  HOME_BOARD_LG_COLS,
  HOME_BOARD_MAX_ROWS,
  HOME_BOARD_MAX_ITEMS,
  HOME_BOARD_ALLOWED_SIZES,
  type HomeBoardWidgetKey,
} from "../home-board.js";

/**
 * Loose shape accepted by the pure validator — `i` is a plain string (not yet
 * narrowed to HomeBoardWidgetKey) so "unknown key" can be checked directly,
 * independent of zod's per-item z.enum parsing.
 */
export interface HomeBoardLayoutItemLike {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type HomeBoardLayoutValidationResult =
  | { ok: true }
  | { ok: false; error: string };

function isWidgetKey(i: string): i is HomeBoardWidgetKey {
  return (HOME_BOARD_WIDGET_KEYS as readonly string[]).includes(i);
}

function isNonNegativeInt(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

function rectanglesOverlap(a: HomeBoardLayoutItemLike, b: HomeBoardLayoutItemLike): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Pure, framework-agnostic validation of a home board layout: bounds,
 * per-widget allowed sizes, duplicate/unknown keys, and pairwise overlap.
 * Used both as the zod `.superRefine` body (below) and directly in unit
 * tests — see packages/shared/src/__tests__/home-board-layout.test.ts.
 */
export function validateHomeBoardLayout(
  layout: readonly HomeBoardLayoutItemLike[],
): HomeBoardLayoutValidationResult {
  if (layout.length > HOME_BOARD_MAX_ITEMS) {
    return {
      ok: false,
      error: `Layout has ${layout.length} items; max is ${HOME_BOARD_MAX_ITEMS}`,
    };
  }

  const seen = new Set<string>();
  for (const item of layout) {
    if (
      !isNonNegativeInt(item.x) ||
      !isNonNegativeInt(item.y) ||
      !isNonNegativeInt(item.w) ||
      !isNonNegativeInt(item.h)
    ) {
      return { ok: false, error: `${item.i}: x, y, w, h must be non-negative integers` };
    }

    if (!isWidgetKey(item.i)) {
      return { ok: false, error: `Unknown widget key: ${item.i}` };
    }

    if (seen.has(item.i)) {
      return { ok: false, error: `Duplicate widget key: ${item.i}` };
    }
    seen.add(item.i);

    if (item.x + item.w > HOME_BOARD_LG_COLS) {
      return { ok: false, error: `${item.i}: x+w exceeds ${HOME_BOARD_LG_COLS} columns` };
    }
    if (item.y + item.h > HOME_BOARD_MAX_ROWS) {
      return { ok: false, error: `${item.i}: y+h exceeds ${HOME_BOARD_MAX_ROWS} rows` };
    }

    const allowed = HOME_BOARD_ALLOWED_SIZES[item.i];
    const sizeOk = allowed.some((size) => size.w === item.w && size.h === item.h);
    if (!sizeOk) {
      return { ok: false, error: `${item.i}: size ${item.w}x${item.h} is not an allowed size` };
    }
  }

  for (let a = 0; a < layout.length; a++) {
    for (let b = a + 1; b < layout.length; b++) {
      if (rectanglesOverlap(layout[a], layout[b])) {
        return { ok: false, error: `${layout[a].i} overlaps ${layout[b].i}` };
      }
    }
  }

  return { ok: true };
}

export const homeBoardLayoutItemSchema = z.object({
  i: z.enum(HOME_BOARD_WIDGET_KEYS),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(0),
  h: z.number().int().min(0),
});

export type HomeBoardLayoutItemInput = z.infer<typeof homeBoardLayoutItemSchema>;

/**
 * Array-level schema: per-item shape (enum + non-negative ints) via
 * homeBoardLayoutItemSchema, then cross-item business rules (bounds,
 * allowed sizes, duplicates, overlap, max count) via validateHomeBoardLayout.
 */
export const homeBoardLayoutArraySchema = z
  .array(homeBoardLayoutItemSchema)
  .superRefine((layout, ctx) => {
    const result = validateHomeBoardLayout(layout);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
    }
  });

/**
 * `PATCH .../home-board-layout/me` body contract. `.strict()` so an extra
 * client-supplied field — most importantly `schemaVersion` or `userId` — is
 * rejected with 400 rather than silently ignored: the server is the sole
 * source of truth for schemaVersion (stamped on write) and userId (derived
 * from the authenticated board actor, never trusted from the body).
 */
export const updateHomeBoardLayoutSchema = z
  .object({
    layout: homeBoardLayoutArraySchema,
  })
  .strict();

export type UpdateHomeBoardLayout = z.infer<typeof updateHomeBoardLayoutSchema>;
