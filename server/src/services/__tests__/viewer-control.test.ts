import { describe, it, expect } from "vitest";
import { resolveViewerControlLevel } from "../viewer-control.js";

describe("resolveViewerControlLevel", () => {
  it("company default when no user override", () => {
    expect(
      resolveViewerControlLevel({ companyLevel: "own_output", userLevel: null }),
    ).toMatchObject({ level: "own_output", source: "company" });
  });

  it("per-user override wins", () => {
    expect(
      resolveViewerControlLevel({ companyLevel: "own_output", userLevel: "manual" }),
    ).toMatchObject({ level: "manual", source: "user" });
  });

  it("absent company config falls back to own_output", () => {
    expect(
      resolveViewerControlLevel({ companyLevel: null, userLevel: null }),
    ).toMatchObject({ level: "own_output", source: "company" });
  });

  it("corrupted stored value falls back to own_output", () => {
    expect(
      resolveViewerControlLevel({ companyLevel: "garbage", userLevel: null }),
    ).toMatchObject({ level: "own_output" });
    expect(
      resolveViewerControlLevel({ companyLevel: "own_output", userLevel: "nonsense" }),
    ).toMatchObject({ level: "own_output", source: "company" });
  });
});
