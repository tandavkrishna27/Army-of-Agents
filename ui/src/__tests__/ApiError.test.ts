import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";

describe("ApiError.fieldError", () => {
  it("extracts field/id from a 422 body with details and reuses the message", () => {
    const err = new ApiError("Assignee agent not found", 422, {
      error: "Assignee agent not found",
      details: { field: "assigneeAgentId", id: "agent-1" },
    });
    expect(err.fieldError).toEqual({
      field: "assigneeAgentId",
      id: "agent-1",
      message: "Assignee agent not found",
    });
  });

  it("returns null when status is not 422", () => {
    const err = new ApiError("Not found", 404, {
      error: "Not found",
      details: { field: "assigneeAgentId", id: "agent-1" },
    });
    expect(err.fieldError).toBeNull();
  });

  it("returns null when body has no details", () => {
    const err = new ApiError("Bad request", 422, { error: "Bad request" });
    expect(err.fieldError).toBeNull();
  });

  it("returns null when details lacks a string field", () => {
    const err = new ApiError("Conflict", 422, {
      error: "Conflict",
      details: { foo: "bar" },
    });
    expect(err.fieldError).toBeNull();
  });

  it("returns null when details.id is not a string", () => {
    const err = new ApiError("Bad", 422, {
      error: "Bad",
      details: { field: "projectId", id: 42 },
    });
    expect(err.fieldError).toBeNull();
  });

  it("returns null when body is null", () => {
    const err = new ApiError("Server error", 422, null);
    expect(err.fieldError).toBeNull();
  });
});
