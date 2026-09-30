/**
 * Upload allowlist for memory assets — kept in its own module (rather than
 * inline in memory-assets-upload.ts) so tests can import it without pulling
 * in the route file's transitive deps (multer, authz, memory-assets service)
 * and tripping the drizzle-orm ESM require-cycle that breaks Vitest
 * collection on Windows. Imports SUPPORTED_MIME_TYPES from the dependency-free
 * file-import-mime-types.ts (not file-import.ts itself, which also pulls in
 * real @armyofagents/db table objects via extraction.ts/memory-projection.ts
 * and would trip the same cycle).
 *
 * IMPORTANT: pptx (application/vnd.openxmlformats-officedocument.
 * presentationml.presentation) is deliberately NOT in this set. Nothing in
 * extractTextFromBuffer (server/src/services/file-import.ts) reads pptx —
 * only the plain-text family, pdf, and docx are extracted. If pptx support
 * is ever added, it must be added to SUPPORTED_MIME_TYPES in
 * file-import-mime-types.ts AND to this set together, never separately —
 * otherwise a founder can drop a deck on the onboarding memory step, see it
 * "accepted", and have the Librarian silently read nothing from it.
 */
import { SUPPORTED_MIME_TYPES } from "../services/file-import-mime-types.js";

export const SUPPORTED_UPLOAD_MIME_TYPES_SET = new Set<string>([
  ...SUPPORTED_MIME_TYPES,
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);
