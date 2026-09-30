import { describe, expect, it } from "vitest";
import {
  OFFICE_RENDER_MAX_BYTES,
  OfficeRenderTooLargeError,
  assertOfficeRenderSize,
} from "../services/office-render-limits.js";

describe("assertOfficeRenderSize", () => {
  it("passes for a byte size under the limit", () => {
    expect(() => assertOfficeRenderSize(10, 100)).not.toThrow();
  });

  it("passes for a byte size exactly at the limit (strict >, boundary renders)", () => {
    expect(() => assertOfficeRenderSize(100, 100)).not.toThrow();
  });

  it("throws OfficeRenderTooLargeError one byte over the limit", () => {
    expect(() => assertOfficeRenderSize(101, 100)).toThrow(OfficeRenderTooLargeError);
  });

  it("carries the byte size and limit on the error for the 413 body", () => {
    try {
      assertOfficeRenderSize(500, 100);
      throw new Error("expected assertOfficeRenderSize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OfficeRenderTooLargeError);
      const e = err as OfficeRenderTooLargeError;
      expect(e.byteSize).toBe(500);
      expect(e.limit).toBe(100);
      // Message names the download fallback (surfaced to the client).
      expect(e.message).toContain("Download");
    }
  });

  it("defaults to OFFICE_RENDER_MAX_BYTES when no limit is passed", () => {
    // Default cap is a sane sub-upload-cap size (< the 50 MB asset limit).
    expect(OFFICE_RENDER_MAX_BYTES).toBeGreaterThan(0);
    expect(OFFICE_RENDER_MAX_BYTES).toBeLessThan(50 * 1024 * 1024);
    expect(() => assertOfficeRenderSize(OFFICE_RENDER_MAX_BYTES)).not.toThrow();
    expect(() => assertOfficeRenderSize(OFFICE_RENDER_MAX_BYTES + 1)).toThrow(
      OfficeRenderTooLargeError,
    );
  });
});
