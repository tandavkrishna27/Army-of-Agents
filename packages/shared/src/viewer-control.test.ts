import { describe, it, expect } from "vitest";
import { VIEWER_CONTROL_LEVELS, isViewerControlLevel } from "./viewer-control.js";

describe("viewer-control", () => {
  it("accepts valid levels", () => {
    expect(isViewerControlLevel("own_output")).toBe(true);
  });

  it("rejects unknown strings", () => {
    expect(isViewerControlLevel("garbage")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isViewerControlLevel(5)).toBe(false);
  });

  it("exposes the canonical level ordering", () => {
    expect([...VIEWER_CONTROL_LEVELS]).toEqual(["manual", "own_output", "full"]);
  });
});
