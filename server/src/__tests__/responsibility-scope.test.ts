import { describe, expect, it } from "vitest";
import {
  buildResponsibilityScope,
  type ResponsibilityEntity,
} from "../services/responsibility-scope.js";

function entity(
  type: "user" | "agent",
  id: string,
  parentType: "user" | "agent" | null,
  parentId: string | null,
): ResponsibilityEntity {
  return { type, id, label: id.toUpperCase(), parentType, parentId };
}

describe("buildResponsibilityScope", () => {
  it("walks a mixed human and agent reporting subtree", () => {
    const scope = buildResponsibilityScope("founder", [
      entity("user", "founder", null, null),
      entity("user", "lead", "user", "founder"),
      entity("agent", "atlas", "user", "lead"),
      entity("agent", "worker", "agent", "atlas"),
      entity("user", "operator", "agent", "worker"),
      entity("user", "unrelated", null, null),
    ]);

    expect(scope.userIds).toEqual(["lead", "operator"]);
    expect(scope.agentIds).toEqual(["atlas", "worker"]);
    expect(scope.labels["agent:atlas"]).toBe("ATLAS");
    expect(scope.truncated).toBe(false);
  });

  it("does not include the root user as its own descendant when the graph cycles", () => {
    const scope = buildResponsibilityScope("founder", [
      entity("user", "founder", "agent", "loop"),
      entity("agent", "loop", "user", "founder"),
    ]);

    expect(scope.userIds).toEqual([]);
    expect(scope.agentIds).toEqual(["loop"]);
    expect(scope.truncated).toBe(false);
  });

  it("marks a hierarchy as truncated when it exceeds the depth guard", () => {
    const scope = buildResponsibilityScope("founder", [
      entity("user", "founder", null, null),
      entity("agent", "one", "user", "founder"),
      entity("agent", "two", "agent", "one"),
      entity("agent", "three", "agent", "two"),
    ], 2);

    expect(scope.agentIds).toEqual(["one", "two"]);
    expect(scope.truncated).toBe(true);
  });

  it("deduplicates a node reached through a malformed repeated definition", () => {
    const scope = buildResponsibilityScope("founder", [
      entity("user", "founder", null, null),
      entity("agent", "atlas", "user", "founder"),
      entity("agent", "atlas", "user", "founder"),
    ]);

    expect(scope.agentIds).toEqual(["atlas"]);
  });
});
