import { describe, it, expect } from "vitest";
import { deriveConfirmEntityLine } from "../components/InternalAgentPanel";

describe("deriveConfirmEntityLine", () => {
  it("update_company_identity → 'This will update company identity'", () => {
    expect(deriveConfirmEntityLine("update_company_identity")).toBe(
      "This will update company identity",
    );
  });

  it("create_task → 'This will create task'", () => {
    expect(deriveConfirmEntityLine("create_task")).toBe("This will create task");
  });

  it("delete_agent → 'This will delete agent'", () => {
    expect(deriveConfirmEntityLine("delete_agent")).toBe("This will delete agent");
  });

  it("set_company_budget → 'This will set company budget'", () => {
    expect(deriveConfirmEntityLine("set_company_budget")).toBe(
      "This will set company budget",
    );
  });

  it("add_team_member → 'This will add team member'", () => {
    expect(deriveConfirmEntityLine("add_team_member")).toBe(
      "This will add team member",
    );
  });

  it("unknown verb falls back to run-form", () => {
    expect(deriveConfirmEntityLine("foo_bar_baz")).toBe(
      "This will run foo bar baz",
    );
  });

  it("single-token unknown verb falls back to run-form", () => {
    expect(deriveConfirmEntityLine("frobnicate")).toBe(
      "This will run frobnicate",
    );
  });

  it("truncates to 80 chars with ellipsis", () => {
    // Construct an action that would produce a line > 80 chars
    const longAction = "update_" + "a".repeat(80);
    const result = deriveConfirmEntityLine(longAction);
    // Result must be at most 80 chars (79 chars + "…" = 80 chars)
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith("…")).toBe(true);
  });

  it("does not truncate lines at exactly 80 chars", () => {
    // "This will update " is 17 chars; entity part needs to make total exactly 80
    // "update" + "_" + "x".repeat(63) → "This will update " + "x".repeat(63) = 17 + 63 = 80
    const action = "update_" + "x".repeat(63);
    const result = deriveConfirmEntityLine(action);
    expect(result.length).toBe(80);
    expect(result.endsWith("…")).toBe(false);
  });
});
