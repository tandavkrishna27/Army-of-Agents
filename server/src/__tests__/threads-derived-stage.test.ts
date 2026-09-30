import { describe, expect, it } from "vitest";
import { createDiscussionDb } from "./helpers/mock-db.js";
import { discussionService } from "../services/discussions.js";

const COMPANY = "co-derived";

describe("discussionService derivedStage payload", () => {
  it("includes derivedStage on list rows", async () => {
    const thread = {
      id: "thread1",
      companyId: COMPANY,
      subtype: "normal",
      status: "active",
      entrySeq: 7,
      scopeType: null,
      scopeId: null,
    };
    const latest = {
      id: "scope1",
      threadId: "thread1",
      versionNumber: 1,
      status: "completed",
      sourceEndSeq: 5,
    };
    const db = createDiscussionDb([
      [thread],
      [],
      [],
      [latest],
      [{ scopeVersionId: "scope1", appliedItemCount: 2 }],
    ]);

    const result = await discussionService(db).list(COMPANY);

    expect(result[0].derivedStage).toMatchObject({
      stage: "discussing",
      label: "Discussing v2",
      versionNumber: 2,
      scopeVersionId: "scope1",
      hasNewEntries: true,
      newEntryCount: 2,
    });
  });

  it("includes derivedStage on detail payload", async () => {
    const thread = {
      id: "thread1",
      companyId: COMPANY,
      subtype: "normal",
      status: "active",
      entrySeq: 7,
    };
    const latest = {
      id: "scope1",
      threadId: "thread1",
      versionNumber: 1,
      status: "completed",
      sourceEndSeq: 5,
    };
    const db = createDiscussionDb([
      [thread],
      [],
      [],
      [],
      [latest],
      [{ scopeVersionId: "scope1", appliedItemCount: 2 }],
    ]);

    const result = await discussionService(db).getById(COMPANY, "thread1");

    expect(result?.derivedStage).toMatchObject({
      stage: "discussing",
      label: "Discussing v2",
      versionNumber: 2,
      scopeVersionId: "scope1",
      hasNewEntries: true,
      newEntryCount: 2,
    });
  });

  it("moves an accepted scope with newer entries back to discussing vNext", async () => {
    const thread = {
      id: "thread1",
      companyId: COMPANY,
      subtype: "normal",
      status: "active",
      entrySeq: 3,
    };
    const latest = {
      id: "scope1",
      threadId: "thread1",
      versionNumber: 1,
      status: "accepted",
      sourceEndSeq: 2,
    };
    const db = createDiscussionDb([
      [thread],
      [],
      [],
      [],
      [latest],
      [{ scopeVersionId: "scope1", appliedItemCount: 2 }],
    ]);

    const result = await discussionService(db).getById(COMPANY, "thread1");

    expect(result?.derivedStage).toMatchObject({
      stage: "discussing",
      label: "Discussing v2",
      versionNumber: 2,
      scopeVersionId: "scope1",
      hasNewEntries: true,
      newEntryCount: 1,
    });
  });
});
