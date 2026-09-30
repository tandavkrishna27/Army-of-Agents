import { describe, expect, it } from "vitest";
import {
  filterCommanderMemoryItems,
  type CommanderMemoryCandidate,
} from "../services/internal-agent/memory-policy.js";

function baseScope(overrides: Record<string, string | null> = {}) {
  return {
    surface: "task" as const,
    route: null,
    departmentId: null,
    projectId: null,
    goalId: null,
    taskId: null,
    conversationId: null,
    memoryFolderPath: null,
    ...overrides,
  };
}

function item(overrides: Partial<CommanderMemoryCandidate>): CommanderMemoryCandidate {
  return {
    id: "memory-1",
    layer: "domain",
    status: "approved",
    visibility: "scoped",
    expiresAt: null,
    departmentId: null,
    projectId: null,
    goalId: null,
    taskId: null,
    conversationId: null,
    createdBy: "user-1",
    ...overrides,
  };
}

describe("filterCommanderMemoryItems", () => {
  it("allows founder to see all approved memory layers", () => {
    const result = filterCommanderMemoryItems({
      items: [
        item({ id: "identity", layer: "identity", status: "approved" }),
        item({ id: "working", layer: "working", status: "approved" }),
      ],
      userRole: "founder",
      userId: "founder-1",
      scope: baseScope(),
      mode: "explicit_query",
    });

    expect(result.map((i) => i.id)).toEqual(["identity", "working"]);
  });

  it("keeps automatic working recall current-scope only", () => {
    const result = filterCommanderMemoryItems({
      items: [
        item({ id: "same-task", layer: "working", departmentId: "dept-1", taskId: "task-1", status: "approved" }),
        item({ id: "other-task", layer: "working", departmentId: "dept-1", taskId: "task-2", status: "approved" }),
      ],
      userRole: "team_member",
      userId: "user-1",
      scope: baseScope({ departmentId: "dept-1", taskId: "task-1" }),
      mode: "automatic_context",
    });

    expect(result.map((i) => i.id)).toEqual(["same-task"]);
  });

  it("uses the item's most specific scope instead of matching a broad ancestor", () => {
    const result = filterCommanderMemoryItems({
      items: [
        item({ id: "task-memory", layer: "working", departmentId: "dept-1", taskId: "task-2" }),
      ],
      userRole: "team_member",
      userId: "user-1",
      scope: baseScope({ departmentId: "dept-1", taskId: "task-1" }),
      mode: "automatic_context",
    });

    expect(result).toEqual([]);
  });

  it("blocks pending durable memory from Commander prompt injection", () => {
    const result = filterCommanderMemoryItems({
      items: [item({ id: "pending-domain", layer: "domain", status: "pending" })],
      userRole: "founder",
      userId: "founder-1",
      scope: baseScope(),
      mode: "automatic_context",
    });

    expect(result).toEqual([]);
  });

  it("hides pending and rejected items from explicit query results", () => {
    const result = filterCommanderMemoryItems({
      items: [
        item({ id: "approved", layer: "domain", status: "approved" }),
        item({ id: "pending", layer: "domain", status: "pending" }),
        item({ id: "rejected", layer: "domain", status: "rejected" }),
      ],
      userRole: "founder",
      userId: "founder-1",
      scope: baseScope(),
      mode: "explicit_query",
    });

    expect(result.map((i) => i.id)).toEqual(["approved"]);
  });

  it("hides archived and expired working memory", () => {
    const result = filterCommanderMemoryItems({
      items: [
        item({ id: "archived", layer: "working", status: "archived", taskId: "task-1" }),
        item({ id: "expired", layer: "working", status: "approved", taskId: "task-1", expiresAt: "2026-05-01T00:00:00.000Z" }),
        item({ id: "fresh", layer: "working", status: "approved", taskId: "task-1", expiresAt: "2026-06-07T00:00:00.000Z" }),
      ],
      userRole: "team_member",
      userId: "user-1",
      scope: baseScope({ taskId: "task-1" }),
      mode: "automatic_context",
      now: new Date("2026-05-31T00:00:00.000Z"),
    });

    expect(result.map((i) => i.id)).toEqual(["fresh"]);
  });

  it("prevents team members from seeing identity memory", () => {
    const result = filterCommanderMemoryItems({
      items: [item({ id: "identity", layer: "identity", visibility: "shared" })],
      userRole: "team_member",
      userId: "user-1",
      scope: baseScope(),
      mode: "explicit_query",
    });

    expect(result).toEqual([]);
  });

  it("allows explicit query to include self-created working memory", () => {
    const result = filterCommanderMemoryItems({
      items: [item({ id: "mine", layer: "working", createdBy: "user-1" })],
      userRole: "team_member",
      userId: "user-1",
      scope: baseScope(),
      mode: "explicit_query",
    });

    expect(result.map((i) => i.id)).toEqual(["mine"]);
  });
});
