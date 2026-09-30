import { describe, expect, it } from "vitest";
import {
  normalizeCommanderContextScope,
  parseCommanderContextScopeJson,
} from "../services/internal-agent/context-scope.js";

describe("normalizeCommanderContextScope", () => {
  it("derives department context from legacy departmentContext", () => {
    const scope = normalizeCommanderContextScope({
      contextScope: null,
      departmentContext: "550e8400-e29b-41d4-a716-446655440001",
      conversationId: "550e8400-e29b-41d4-a716-446655440002",
    });

    expect(scope.departmentId).toBe("550e8400-e29b-41d4-a716-446655440001");
    expect(scope.conversationId).toBe("550e8400-e29b-41d4-a716-446655440002");
    expect(scope.surface).toBe("commander");
  });

  it("keeps project, goal, task, and memory folder scope", () => {
    const scope = normalizeCommanderContextScope({
      contextScope: {
        surface: "memory",
        projectId: "550e8400-e29b-41d4-a716-446655440003",
        goalId: "550e8400-e29b-41d4-a716-446655440004",
        taskId: "550e8400-e29b-41d4-a716-446655440005",
        memoryFolderPath: "Company/Product",
      },
      departmentContext: null,
      conversationId: null,
    });

    expect(scope).toMatchObject({
      surface: "memory",
      projectId: "550e8400-e29b-41d4-a716-446655440003",
      goalId: "550e8400-e29b-41d4-a716-446655440004",
      taskId: "550e8400-e29b-41d4-a716-446655440005",
      memoryFolderPath: "Company/Product",
    });
  });

  it("returns null scope when MCP bridge env JSON is malformed", () => {
    expect(parseCommanderContextScopeJson("{bad json")).toBeNull();
  });
});
