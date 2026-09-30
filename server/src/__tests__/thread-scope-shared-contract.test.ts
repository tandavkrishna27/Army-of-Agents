import { describe, expect, it } from "vitest";
import {
  THREAD_DERIVED_STAGES,
  THREAD_SCOPE_ITEM_KINDS,
  THREAD_SCOPE_ITEM_STATUSES,
  THREAD_SCOPE_VERSION_STATUSES,
} from "@armyofagents/shared";

describe("thread scope shared constants", () => {
  it("exports scope version statuses", () => {
    expect(THREAD_SCOPE_VERSION_STATUSES).toEqual([
      "draft",
      "accepted",
      "superseded",
      "completed",
      "rejected",
    ]);
  });

  it("exports scope item kinds and statuses", () => {
    expect(THREAD_SCOPE_ITEM_KINDS).toContain("task_proposal");
    expect(THREAD_SCOPE_ITEM_KINDS).toContain("memory_candidate");
    expect(THREAD_SCOPE_ITEM_KINDS).toContain("artifact_link");
    expect(THREAD_SCOPE_ITEM_STATUSES).toEqual(["draft", "accepted", "applied", "rejected"]);
  });

  it("exports derived stage names", () => {
    expect(THREAD_DERIVED_STAGES).toEqual([
      "live",
      "discussing",
      "scoping",
      "scoped",
      "assigned",
      "complete",
      "archived",
    ]);
  });
});
