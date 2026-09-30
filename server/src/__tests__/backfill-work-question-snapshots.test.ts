import { describe, expect, it } from "vitest";
import { buildWorkQuestionSnapshotPatch } from "../migrations/backfill-work-question-snapshots.js";

describe("buildWorkQuestionSnapshotPatch", () => {
  it("fills missing identity from live linked records", () => {
    const patch = buildWorkQuestionSnapshotPatch({
      issueIdentifierSnapshot: null,
      issueTitleSnapshot: null,
      askingAgentNameSnapshot: null,
      issueIdentifier: "NOR-8",
      issueTitle: "Compare launch interview approaches",
      askingAgentName: "Nila",
    });

    expect(patch).toMatchObject({
      issueIdentifierSnapshot: "NOR-8",
      issueTitleSnapshot: "Compare launch interview approaches",
      askingAgentNameSnapshot: "Nila",
    });
    expect(patch.updatedAt).toBeInstanceOf(Date);
  });

  it("preserves existing snapshots and skips unavailable linked identity", () => {
    expect(buildWorkQuestionSnapshotPatch({
      issueIdentifierSnapshot: "OLD-1",
      issueTitleSnapshot: "Original title",
      askingAgentNameSnapshot: "Original agent",
      issueIdentifier: "NEW-1",
      issueTitle: "Renamed task",
      askingAgentName: "Renamed agent",
    })).toEqual({});

    expect(buildWorkQuestionSnapshotPatch({
      issueIdentifierSnapshot: null,
      issueTitleSnapshot: null,
      askingAgentNameSnapshot: null,
      issueIdentifier: null,
      issueTitle: null,
      askingAgentName: null,
    })).toEqual({});
  });
});
