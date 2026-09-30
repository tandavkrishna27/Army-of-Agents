import { describe, it, expect } from "vitest";
import { SUPPORTED_MIME_TYPES } from "../services/file-import-mime-types.js";
import { SUPPORTED_UPLOAD_MIME_TYPES_SET } from "../routes/memory-asset-upload-types.js";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
// Types we store deliberately without reading — the founder sees them in the
// memory tree, and the Librarian is instructed not to describe them.
const STORE_ONLY = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "video/mp4", "video/webm", "video/quicktime",
]);

describe("upload allowlist honesty", () => {
  it("does not accept .pptx, which nothing can extract", () => {
    expect(SUPPORTED_UPLOAD_MIME_TYPES_SET.has(PPTX)).toBe(false);
  });

  it("every accepted type is either extractable or deliberately store-only", () => {
    const extractable = new Set<string>(SUPPORTED_MIME_TYPES);
    const unexplained = [...SUPPORTED_UPLOAD_MIME_TYPES_SET].filter(
      (t) => !extractable.has(t) && !STORE_ONLY.has(t),
    );
    expect(unexplained).toEqual([]);
  });
});
