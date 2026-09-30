/**
 * Coerce timestamp columns returned from a RAW SQL query into Date objects.
 *
 * Why: with the postgres.js driver, `db.execute(sql.raw(...))` (and raw `sql`
 * templates) bypass Drizzle's column type-mapping, so `timestamp`/`timestamptz`
 * columns come back as STRINGS, not Date. Downstream Drizzle comparisons on a
 * timestamp column (e.g. `gt(table.createdAt, value)`) call `value.toISOString()`
 * and throw "v.toISOString is not a function" when handed a string. Run raw
 * embedding_queue rows through this before using their timestamps as Dates.
 *
 * This helper is scoped to the embedding_queue row shape (createdAt / updatedAt /
 * nextRetryAt). It is intentionally NOT a general-purpose coercer: other raw
 * queries return different timestamp columns and should coerce their own set.
 */
function toDate(v: unknown): Date | null | undefined {
  if (v == null) return v as null | undefined;
  if (v instanceof Date) return v;
  return new Date(v as string);
}

export function coerceQueueRowTimestamps<T extends Record<string, unknown>>(
  row: T,
): T {
  return {
    ...row,
    ...("createdAt" in row ? { createdAt: toDate(row.createdAt) } : {}),
    ...("updatedAt" in row ? { updatedAt: toDate(row.updatedAt) } : {}),
    ...("nextRetryAt" in row ? { nextRetryAt: toDate(row.nextRetryAt) } : {}),
  } as T;
}
