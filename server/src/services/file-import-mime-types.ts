/**
 * MIME-type constants for the file-import pipeline, split out of
 * file-import.ts so they can be imported without pulling in that file's
 * transitive real-db dependencies (extraction.ts, memory-projection.ts,
 * db-capabilities.ts all import real @armyofagents/db table objects, which
 * trips the drizzle-orm ESM require-cycle that breaks Vitest collection on
 * Windows). This module has zero imports — safe to import from anywhere,
 * including tests.
 */

export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  // Item 5: founders drop notes/exports on the onboarding memory step, and
  // these are all UTF-8 text — extracting them is the same code path as
  // text/plain. This list also feeds the memory-asset upload allowlist
  // (memory-asset-upload-types.ts spreads it), so a dropped .md stopped being a
  // 400 the moment it became extractable.
  "text/markdown",
  "text/csv",
  "application/json",
] as const;

/** MIME types handled by the plain-UTF-8 branch of extractTextFromBuffer. */
export const PLAIN_TEXT_MIME_TYPES = new Set<string>([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];
