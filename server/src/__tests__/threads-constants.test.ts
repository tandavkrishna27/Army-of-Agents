import { describe, it, expect } from "vitest";
import {
  THREAD_PHASES,
  THREAD_VISIBILITIES,
  THREAD_ORIGIN_SOURCES,
  THREAD_PARTICIPANT_ROLES,
  THREAD_LINK_KINDS,
  THREAD_INBOX_STATUSES,
  DISCUSSION_ENTRY_INPUT_TYPES,
  EXTRACTION_ITEM_TYPES,
} from "@armyofagents/shared";

describe("Threads constants", () => {
  it("THREAD_PHASES are the four lifecycle phases in order", () => {
    expect(THREAD_PHASES).toEqual(["discuss", "scope", "assign", "done"]);
  });

  it("THREAD_VISIBILITIES = private|department|company (Phase 1 canonicalized)", () => {
    expect(THREAD_VISIBILITIES).toEqual(["private", "department", "company"]);
  });

  it("THREAD_ORIGIN_SOURCES cover human/agent/external/system", () => {
    expect(THREAD_ORIGIN_SOURCES).toEqual([
      "human",
      "agent",
      "external",
      "system",
    ]);
  });

  it("participant roles include owner and worker", () => {
    expect(THREAD_PARTICIPANT_ROLES).toContain("owner");
    expect(THREAD_PARTICIPANT_ROLES).toContain("co_owner");
    expect(THREAD_PARTICIPANT_ROLES).toContain("worker");
  });

  it("link kinds include spawned_from_task (for the later worker->thread write-back)", () => {
    expect(THREAD_LINK_KINDS).toContain("spawned_from_task");
  });

  it("inbox statuses cover the triage lifecycle", () => {
    expect(THREAD_INBOX_STATUSES).toEqual(["pending", "attached", "dismissed"]);
  });

  it("entry input types are widened for thread origins", () => {
    for (const t of [
      "transcript",
      "document",
      "routine",
      "webhook",
      "integration",
      "agent",
    ]) {
      expect(DISCUSSION_ENTRY_INPUT_TYPES).toContain(t);
    }
    // backward-compat values preserved
    expect(DISCUSSION_ENTRY_INPUT_TYPES).toContain("paste");
    expect(DISCUSSION_ENTRY_INPUT_TYPES).toContain("voice");
  });

  it("extracted item types include artifact + spin_off_thread", () => {
    expect(EXTRACTION_ITEM_TYPES).toContain("artifact");
    expect(EXTRACTION_ITEM_TYPES).toContain("spin_off_thread");
    // existing values preserved
    expect(EXTRACTION_ITEM_TYPES).toContain("decision");
    expect(EXTRACTION_ITEM_TYPES).toContain("task");
  });
});
