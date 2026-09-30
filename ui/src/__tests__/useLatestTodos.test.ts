import { describe, it, expect } from "vitest";
import { extractTodosFromEntries } from "../components/workspace/useLatestTodos";

describe("extractTodosFromEntries", () => {
  it("extracts todos from latest TodoWrite entry", () => {
    const entries = [
      { kind: "assistant", text: "Working on it" },
      {
        kind: "tool_call",
        name: "TodoWrite",
        input: {
          todos: [
            { content: "Setup project", status: "completed" },
            { content: "Write tests", status: "in_progress" },
            { content: "Deploy", status: "pending" },
          ],
        },
      },
      { kind: "assistant", text: "Done with setup" },
    ];
    const result = extractTodosFromEntries(entries);
    expect(result.total).toBe(3);
    expect(result.completed).toBe(1);
    expect(result.todos).toHaveLength(3);
    expect(result.todos[0].content).toBe("Setup project");
    expect(result.todos[0].status).toBe("completed");
  });

  it("returns last TodoWrite when multiple exist", () => {
    const entries = [
      {
        kind: "tool_call",
        name: "TodoWrite",
        input: {
          todos: [{ content: "Old task", status: "pending" }],
        },
      },
      {
        kind: "tool_call",
        name: "TodoWrite",
        input: {
          todos: [
            { content: "Task A", status: "completed" },
            { content: "Task B", status: "completed" },
          ],
        },
      },
    ];
    const result = extractTodosFromEntries(entries);
    expect(result.total).toBe(2);
    expect(result.completed).toBe(2);
  });

  it("returns empty when no TodoWrite exists", () => {
    const entries = [
      { kind: "assistant", text: "Hello" },
      { kind: "tool_call", name: "Read", input: { path: "/file.txt" } },
    ];
    const result = extractTodosFromEntries(entries);
    expect(result.total).toBe(0);
    expect(result.todos).toHaveLength(0);
  });

  it("returns empty for empty entries", () => {
    const result = extractTodosFromEntries([]);
    expect(result.total).toBe(0);
  });

  it("handles update_progress tool name", () => {
    const entries = [
      {
        kind: "tool_call",
        name: "update_progress",
        input: {
          todos: [{ content: "A task", status: "completed" }],
        },
      },
    ];
    const result = extractTodosFromEntries(entries);
    expect(result.total).toBe(1);
    expect(result.completed).toBe(1);
  });

  it("defaults to pending for unknown status", () => {
    const entries = [
      {
        kind: "tool_call",
        name: "TodoWrite",
        input: {
          todos: [{ content: "Something", status: "unknown_status" }],
        },
      },
    ];
    const result = extractTodosFromEntries(entries);
    expect(result.todos[0].status).toBe("pending");
  });
});
