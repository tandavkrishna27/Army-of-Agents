import { describe, it, expect } from "vitest";
import {
  mapExtractionStatus,
  inferScope,
} from "../migrations/v2_5-migrate-debriefs-to-discussions.js";

describe("mapExtractionStatus", () => {
  it("maps 'ready' to 'completed'", () => {
    expect(mapExtractionStatus("ready", true)).toBe("completed");
    expect(mapExtractionStatus("ready", false)).toBe("completed");
  });

  it("maps 'processing' to 'completed' when items exist", () => {
    expect(mapExtractionStatus("processing", true)).toBe("completed");
  });

  it("maps 'processing' to 'failed' when no items exist", () => {
    expect(mapExtractionStatus("processing", false)).toBe("failed");
  });

  it("maps 'processing_failed' to 'failed'", () => {
    expect(mapExtractionStatus("processing_failed", true)).toBe("failed");
    expect(mapExtractionStatus("processing_failed", false)).toBe("failed");
  });

  it("maps 'archived' to 'completed'", () => {
    expect(mapExtractionStatus("archived", true)).toBe("completed");
    expect(mapExtractionStatus("archived", false)).toBe("completed");
  });

  it("defaults unknown status to 'failed'", () => {
    expect(mapExtractionStatus("unknown_status", true)).toBe("failed");
  });
});

describe("inferScope", () => {
  it("returns goal scope when goalId is present", () => {
    const result = inferScope({
      goalId: "goal-1",
      projectId: "project-1",
      departmentId: "dept-1",
    });
    expect(result).toEqual({ scopeType: "goal", scopeId: "goal-1" });
  });

  it("returns project scope when projectId is present (no goalId)", () => {
    const result = inferScope({
      goalId: null,
      projectId: "project-1",
      departmentId: "dept-1",
    });
    expect(result).toEqual({ scopeType: "project", scopeId: "project-1" });
  });

  it("returns department scope when departmentId is present (no goalId/projectId)", () => {
    const result = inferScope({
      goalId: null,
      projectId: null,
      departmentId: "dept-1",
    });
    expect(result).toEqual({ scopeType: "department", scopeId: "dept-1" });
  });

  it("returns null scope when no IDs are present", () => {
    const result = inferScope({
      goalId: null,
      projectId: null,
      departmentId: null,
    });
    expect(result).toEqual({ scopeType: null, scopeId: null });
  });
});
