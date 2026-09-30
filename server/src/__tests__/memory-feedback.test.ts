import { describe, it, expect } from "vitest";
import {
  detectToneCorrections,
  detectFormatChanges,
  detectContentAdditions,
  detectTerminologyChanges,
} from "../services/memory-feedback-detectors.js";

// Helper to create test edit records
function makeEdit(
  overrides: Partial<{
    briefItemId: string;
    briefId: string;
    originalTitle: string;
    originalDescription: string | null;
    editedTitle: string;
    editedDescription: string | null;
    agentId: string | null;
    editedAt: string;
  }> = {},
) {
  return {
    briefItemId: overrides.briefItemId ?? crypto.randomUUID(),
    briefId: overrides.briefId ?? "brief-1",
    originalTitle: overrides.originalTitle ?? "Original title",
    originalDescription: overrides.originalDescription ?? "Original description",
    editedTitle: overrides.editedTitle ?? "Edited title",
    editedDescription: overrides.editedDescription ?? "Edited description",
    agentId: overrides.agentId ?? "agent-1",
    editedAt: overrides.editedAt ?? new Date().toISOString(),
  };
}

describe("Memory Feedback Detectors", () => {
  describe("detectToneCorrections", () => {
    it("detects tone corrections when wording changes but words overlap", () => {
      const edits = [
        makeEdit({
          originalTitle: "Please complete the task quickly",
          editedTitle: "Kindly complete the task at your convenience",
        }),
        makeEdit({
          originalTitle: "Fix this bug immediately",
          editedTitle: "Please address this bug when possible",
        }),
        makeEdit({
          originalTitle: "Send the report now",
          editedTitle: "Please send the report today",
        }),
      ];

      const patterns = detectToneCorrections(edits);
      expect(patterns.length).toBe(1);
      expect(patterns[0].patternType).toBe("tone_correction");
      expect(patterns[0].occurrenceCount).toBe(3);
      expect(patterns[0].sourceAgentId).toBe("agent-1");
    });

    it("does not detect tone correction when titles are identical", () => {
      const edits = [
        makeEdit({
          originalTitle: "Same title",
          editedTitle: "Same title",
        }),
        makeEdit({
          originalTitle: "Same title",
          editedTitle: "Same title",
        }),
        makeEdit({
          originalTitle: "Same title",
          editedTitle: "Same title",
        }),
      ];

      const patterns = detectToneCorrections(edits);
      expect(patterns.length).toBe(0);
    });

    it("groups patterns by agent", () => {
      const edits = [
        makeEdit({
          agentId: "agent-1",
          originalTitle: "Do this task now",
          editedTitle: "Please do this task soon",
        }),
        makeEdit({
          agentId: "agent-1",
          originalTitle: "Complete the work fast",
          editedTitle: "Please complete the work promptly",
        }),
        makeEdit({
          agentId: "agent-2",
          originalTitle: "Handle this request urgently",
          editedTitle: "Please handle this request when available",
        }),
      ];

      const patterns = detectToneCorrections(edits);
      // Should create separate patterns per agent
      expect(patterns.length).toBe(2);
      const agent1Pattern = patterns.find((p) => p.sourceAgentId === "agent-1");
      const agent2Pattern = patterns.find((p) => p.sourceAgentId === "agent-2");
      expect(agent1Pattern?.occurrenceCount).toBe(2);
      expect(agent2Pattern?.occurrenceCount).toBe(1);
    });
  });

  describe("detectFormatChanges", () => {
    it("detects format changes when markdown structure differs", () => {
      const edits = [
        makeEdit({
          originalDescription: "Step one. Step two. Step three.",
          editedDescription: "- Step one\n- Step two\n- Step three",
        }),
        makeEdit({
          originalDescription: "First thing. Second thing.",
          editedDescription: "1. First thing\n2. Second thing",
        }),
        makeEdit({
          originalDescription: "Title and content here",
          editedDescription: "# Title\n\ncontent here",
        }),
      ];

      const patterns = detectFormatChanges(edits);
      expect(patterns.length).toBe(1);
      expect(patterns[0].patternType).toBe("format_change");
      expect(patterns[0].occurrenceCount).toBe(3);
    });

    it("does not detect format changes when descriptions are identical", () => {
      const edits = [
        makeEdit({
          originalDescription: "Same description",
          editedDescription: "Same description",
        }),
      ];

      const patterns = detectFormatChanges(edits);
      expect(patterns.length).toBe(0);
    });
  });

  describe("detectContentAdditions", () => {
    it("detects content additions when edited version is substantially longer", () => {
      const edits = [
        makeEdit({
          originalTitle: "Task A",
          originalDescription: "Do thing A",
          editedTitle: "Task A",
          editedDescription:
            "Do thing A. Also make sure to check B, verify C, and test D thoroughly.",
        }),
        makeEdit({
          originalTitle: "Task B",
          originalDescription: "Fix the bug",
          editedTitle: "Task B",
          editedDescription:
            "Fix the bug. Include regression tests and update documentation accordingly.",
        }),
        makeEdit({
          originalTitle: "Task C",
          originalDescription: "Update API",
          editedTitle: "Task C",
          editedDescription:
            "Update API. Ensure backward compatibility, add versioning, and update all client references.",
        }),
      ];

      const patterns = detectContentAdditions(edits);
      expect(patterns.length).toBe(1);
      expect(patterns[0].patternType).toBe("content_addition");
      expect(patterns[0].occurrenceCount).toBe(3);
    });

    it("does not detect content addition when lengths are similar", () => {
      const edits = [
        makeEdit({
          originalTitle: "Same length title here",
          originalDescription: "Same length description here",
          editedTitle: "Same length title edit",
          editedDescription: "Same length description edit",
        }),
      ];

      const patterns = detectContentAdditions(edits);
      expect(patterns.length).toBe(0);
    });
  });

  describe("detectTerminologyChanges", () => {
    it("detects terminology changes when specific words are replaced", () => {
      const edits = [
        makeEdit({
          originalTitle: "Update the client dashboard",
          editedTitle: "Update the customer dashboard",
        }),
        makeEdit({
          originalTitle: "Client onboarding flow",
          editedTitle: "Customer onboarding flow",
        }),
        makeEdit({
          originalTitle: "Client feedback report",
          editedTitle: "Customer feedback report",
        }),
      ];

      const patterns = detectTerminologyChanges(edits);
      expect(patterns.length).toBe(1);
      expect(patterns[0].patternType).toBe("terminology_change");
      expect(patterns[0].occurrenceCount).toBe(3);
    });

    it("does not detect when titles are identical", () => {
      const edits = [
        makeEdit({
          originalTitle: "Exact same",
          editedTitle: "Exact same",
        }),
      ];

      const patterns = detectTerminologyChanges(edits);
      expect(patterns.length).toBe(0);
    });

    it("does not detect when too many words change", () => {
      const edits = [
        makeEdit({
          originalTitle: "Old alpha beta gamma",
          editedTitle: "New one two three four five",
        }),
      ];

      const patterns = detectTerminologyChanges(edits);
      expect(patterns.length).toBe(0);
    });
  });

  describe("threshold behavior (Rule #8)", () => {
    it("below threshold (2 occurrences) — patterns returned but count is 2", () => {
      const edits = [
        makeEdit({
          originalTitle: "Do this task now",
          editedTitle: "Please do this task soon",
        }),
        makeEdit({
          originalTitle: "Complete the work fast",
          editedTitle: "Please complete the work quickly",
        }),
      ];

      const patterns = detectToneCorrections(edits);
      // Detectors return all patterns regardless of threshold
      // (threshold is enforced by runAllDetectors during persistence)
      expect(patterns.length).toBe(1);
      expect(patterns[0].occurrenceCount).toBe(2);
    });

    it("exactly 3 occurrences — pattern has count 3", () => {
      const edits = [
        makeEdit({
          originalTitle: "Do task now",
          editedTitle: "Please do task soon",
        }),
        makeEdit({
          originalTitle: "Fix bug immediately",
          editedTitle: "Please fix bug when available",
        }),
        makeEdit({
          originalTitle: "Send report right away",
          editedTitle: "Please send report today",
        }),
      ];

      const patterns = detectToneCorrections(edits);
      expect(patterns.length).toBe(1);
      expect(patterns[0].occurrenceCount).toBe(3);
    });
  });

  describe("evidence tracking", () => {
    it("includes evidence details for each edit in the pattern", () => {
      const edits = [
        makeEdit({
          briefItemId: "item-1",
          briefId: "brief-1",
          originalTitle: "Do this now",
          editedTitle: "Please do this soon",
          editedAt: "2026-01-01T00:00:00.000Z",
        }),
        makeEdit({
          briefItemId: "item-2",
          briefId: "brief-2",
          originalTitle: "Fix that now",
          editedTitle: "Please fix that soon",
          editedAt: "2026-01-02T00:00:00.000Z",
        }),
      ];

      const patterns = detectToneCorrections(edits);
      expect(patterns[0].evidence).toHaveLength(2);
      expect(patterns[0].evidence[0]).toMatchObject({
        briefItemId: "item-1",
        briefId: "brief-1",
        originalTitle: "Do this now",
        editedTitle: "Please do this soon",
      });
    });
  });

  describe("empty edit history", () => {
    it("returns no patterns when edit list is empty", () => {
      expect(detectToneCorrections([])).toEqual([]);
      expect(detectFormatChanges([])).toEqual([]);
      expect(detectContentAdditions([])).toEqual([]);
      expect(detectTerminologyChanges([])).toEqual([]);
    });
  });

  describe("each detector type works independently", () => {
    it("different edit types are captured by different detectors", () => {
      // Tone correction edit (similar length to avoid triggering content addition)
      const toneEdits = [
        makeEdit({
          originalTitle: "Complete this task immediately now",
          editedTitle: "Please complete this task promptly",
          originalDescription: "some description here",
          editedDescription: "some description here",
        }),
      ];

      // Content addition edit
      const contentEdits = [
        makeEdit({
          originalTitle: "Task",
          originalDescription: "Short",
          editedTitle: "Task",
          editedDescription:
            "Short description that was expanded with lots of additional context and requirements",
        }),
      ];

      // Format change edit
      const formatEdits = [
        makeEdit({
          originalDescription: "Step one. Step two.",
          editedDescription: "- Step one\n- Step two",
        }),
      ];

      // Terminology change edit
      const termEdits = [
        makeEdit({
          originalTitle: "Update client page",
          editedTitle: "Update customer page",
        }),
      ];

      expect(detectToneCorrections(toneEdits).length).toBe(1);
      expect(detectContentAdditions(contentEdits).length).toBe(1);
      expect(detectFormatChanges(formatEdits).length).toBe(1);
      expect(detectTerminologyChanges(termEdits).length).toBe(1);

      // Cross-check: tone edit should not trigger content addition
      expect(detectContentAdditions(toneEdits).length).toBe(0);
    });
  });
});
