import { describe, expect, it } from "vitest";
import {
  buildCommanderContextScopeFromPath,
  completedToolLabel,
  mergeServerMessagesWithTransientLocal,
  settleRunningToolCalls,
  type LocalMessage,
} from "../components/InternalAgentPanel";
import type { AgentMessage } from "../api/internal-agent";

function message(id: string, role: "user" | "assistant", content: string): AgentMessage {
  return {
    id,
    conversationId: "conversation-1",
    role,
    content,
    pageContext: null,
    departmentContext: null,
    metadata: null,
    createdAt: "2026-05-26T00:00:00.000Z",
  };
}

describe("mergeServerMessagesWithTransientLocal", () => {
  it("preserves a local approval card that has no persisted assistant message yet", () => {
    const serverMessages = [message("server-user-1", "user", "Create task")];

    const merged = mergeServerMessagesWithTransientLocal(serverMessages, [
      {
        id: "local-assistant-approval",
        role: "assistant",
        content: "",
        streamingDone: true,
        createdAt: "2026-05-26T00:00:01.000Z",
        actionConfirm: {
          confirmId: "11111111-1111-4111-8111-000000000001",
          action: "create_task",
          description: "Create task",
          status: "pending",
        },
      },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[1].actionConfirm).toMatchObject({
      confirmId: "11111111-1111-4111-8111-000000000001",
      status: "pending",
    });
  });

  it("does not preserve plain local user drafts once server messages arrive", () => {
    const merged = mergeServerMessagesWithTransientLocal(
      [message("server-user-1", "user", "Create task")],
      [
        {
          id: "local-user-1",
          role: "user",
          content: "Create task",
          streamingDone: true,
          createdAt: "2026-05-26T00:00:01.000Z",
        },
      ],
    );

    expect(merged.map((m) => m.id)).toEqual(["server-user-1"]);
  });

  it("preserves a local assistant error that is not persisted by the server", () => {
    const merged = mergeServerMessagesWithTransientLocal(
      [message("server-user-1", "user", "Ping")],
      [
        {
          id: "local-assistant-error",
          role: "assistant",
          content: "No CLI tool configured.",
          streamingDone: true,
          createdAt: "2026-05-26T00:00:01.000Z",
        },
      ],
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      id: "local-assistant-error",
      role: "assistant",
      content: "No CLI tool configured.",
    });
  });

  it("does not duplicate local assistant content once the server has the same assistant message", () => {
    const merged = mergeServerMessagesWithTransientLocal(
      [
        message("server-user-1", "user", "Ping"),
        message("server-assistant-1", "assistant", "Pong"),
      ],
      [
        {
          id: "local-assistant-1",
          role: "assistant",
          content: "Pong",
          streamingDone: true,
          createdAt: "2026-05-26T00:00:01.000Z",
        },
      ],
    );

    expect(merged.map((m) => m.id)).toEqual(["server-user-1", "server-assistant-1"]);
  });
});

describe("settleRunningToolCalls", () => {
  it("marks stale running tool rows done for the matching assistant message", () => {
    const messages: LocalMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        streamingDone: false,
        createdAt: "2026-05-26T00:00:01.000Z",
        toolCalls: [
          { id: 1, name: "ToolSearch", status: "running" },
          { id: 2, name: "mcp__aoa__create_task", status: "running" },
        ],
      },
      {
        id: "assistant-2",
        role: "assistant",
        content: "",
        streamingDone: false,
        createdAt: "2026-05-26T00:00:02.000Z",
        toolCalls: [{ id: 3, name: "mcp__aoa__create_goal", status: "running" }],
      },
    ];

    const settled = settleRunningToolCalls(messages, "assistant-1");

    expect(settled[0].toolCalls?.map((tc) => tc.status)).toEqual(["done", "done"]);
    expect(settled[1].toolCalls?.map((tc) => tc.status)).toEqual(["running"]);
  });
});

describe("completedToolLabel", () => {
  it("does not describe completed tools as still running", () => {
    expect(completedToolLabel("mcp__aoa__create_task")).toBe("Used mcp aoa create task");
    expect(completedToolLabel("query_tasks")).not.toMatch(/running/i);
  });
});

describe("buildCommanderContextScopeFromPath", () => {
  it("derives a UUID task scope from the current route", () => {
    expect(buildCommanderContextScopeFromPath(
      "/P4/projects/550e8400-e29b-41d4-a716-446655440001/issues/550e8400-e29b-41d4-a716-446655440002",
    )).toMatchObject({
      surface: "task",
      projectId: "550e8400-e29b-41d4-a716-446655440001",
      taskId: "550e8400-e29b-41d4-a716-446655440002",
    });
  });

  it("does not send slug-like route refs as UUID scope IDs", () => {
    expect(buildCommanderContextScopeFromPath("/P4/projects/product-roadmap")).toMatchObject({
      surface: "project",
      route: "/P4/projects/product-roadmap",
    });
    expect(buildCommanderContextScopeFromPath("/P4/projects/product-roadmap").projectId).toBeUndefined();
  });
});
