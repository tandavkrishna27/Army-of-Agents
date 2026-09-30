import { describe, expect, it, vi } from "vitest";
import { artifactVersions, artifacts, assets } from "@armyofagents/db";
import { threadScopeVersionService } from "../services/thread-scope-versions.js";

function createSequenceDb(selectQueue: any[][]) {
  let idx = 0;
  const selectChains: any[] = [];

  function makeSelectChain() {
    const chain = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: any[]) => any) =>
        Promise.resolve(fn(selectQueue[idx++] ?? [])),
      ),
    };
    selectChains.push(chain);
    return chain;
  }

  function makeInsertChain() {
    return {
      values: vi.fn(() => ({
        returning: vi.fn().mockReturnThis(),
        then: vi.fn((fn: (rows: any[]) => any) =>
          Promise.resolve(fn(selectQueue[idx++] ?? [])),
        ),
      })),
    };
  }

  return {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => makeInsertChain()),
    __selectChains: selectChains,
  } as any;
}

function sqlConditionContainsColumn(value: unknown, columnName: string): boolean {
  if (!value || typeof value !== "object") return false;
  if ("name" in value && (value as { name?: unknown }).name === columnName) return true;
  if ("queryChunks" in value && Array.isArray((value as { queryChunks?: unknown }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.some((chunk) =>
      sqlConditionContainsColumn(chunk, columnName),
    );
  }
  return false;
}

// Walks a drizzle SQL tree looking for a literal string value (used to assert
// the dedup filter's inArray includes both "pending" and "edited"). drizzle's
// `inArray(col, [...])` places the values array directly inside `queryChunks`,
// so this must descend into arbitrary arrays and object values, not just a
// known key list. Guards against cycles via a visited set.
function sqlConditionContainsValue(
  value: unknown,
  target: string,
  seen: WeakSet<object> = new WeakSet(),
): boolean {
  if (value === target) return true;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.some((item) => sqlConditionContainsValue(item, target, seen));
  }
  return Object.values(value as Record<string, unknown>).some((v) =>
    sqlConditionContainsValue(v, target, seen),
  );
}

describe("threadScopeVersionService.createDraftFromThread", () => {
  it("rejects live threads with conflict", async () => {
    const db = createSequenceDb([
      [{ id: "thread-live", companyId: "co1", subtype: "live", entrySeq: 3 }],
    ]);

    await expect(
      threadScopeVersionService(db).createDraftFromThread(
        "co1",
        "thread-live",
        { userId: "u1", isHuman: true },
        { summary: "Draft" },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("returns no-op when the selected seq range has no entries", async () => {
    const db = createSequenceDb([
      [{ id: "thread1", companyId: "co1", subtype: "normal", entrySeq: 0 }],
      [],
    ]);

    const result = await threadScopeVersionService(db).createDraftFromThread(
      "co1",
      "thread1",
      { userId: "u1", isHuman: true },
      { summary: "Draft" },
    );

    expect(result).toEqual({
      status: "no_entries",
      sourceStartSeq: 1,
      sourceEndSeq: 0,
    });
  });

  it("creates v1 draft from seq 1 through current entrySeq", async () => {
    const version = {
      id: "scope1",
      threadId: "thread1",
      versionNumber: 1,
      sourceStartSeq: 1,
      sourceEndSeq: 2,
      status: "draft",
    };
    const db = createSequenceDb([
      [{ id: "thread1", companyId: "co1", subtype: "normal", entrySeq: 2 }],
      [],
      [
        { id: "entry-1", discussionId: "thread1", seq: 1, inputType: "write", rawContent: "Scope should cover all messages." },
        { id: "entry-2", discussionId: "thread1", seq: 2, inputType: "write", rawContent: "Create tasks from the accepted scope." },
      ],
      [],
      [],
      [version],
    ]);

    const result = await threadScopeVersionService(db).createDraftFromThread(
      "co1",
      "thread1",
      { userId: "u1", isHuman: true },
      { summary: "Draft v1" },
    );

    expect(result).toEqual({ status: "created", version });
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  it("persists artifact metadata from scoped entry attachments into scope items", async () => {
    const version = {
      id: "scope1",
      threadId: "thread1",
      versionNumber: 1,
      sourceStartSeq: 1,
      sourceEndSeq: 1,
      status: "draft",
    };
    const db = createSequenceDb([
      [{ id: "thread1", companyId: "co1", subtype: "normal", entrySeq: 1 }],
      [],
      [
        {
          id: "entry-1",
          discussionId: "thread1",
          seq: 1,
          inputType: "write",
          rawContent: "Use the attached artifact as the source.",
        },
      ],
      [],
      [
        {
          discussionEntryId: "entry-1",
          assetId: null,
          artifactId: "artifact-1",
          artifactVersionId: "artifact-version-1",
          artifactTitle: "Checkout mockup",
          assetOriginalFilename: null,
          assetContentType: null,
          artifactVersionStorageKind: "asset",
          artifactVersionAssetId: "asset-artifact-1",
          artifactVersionFilename: "checkout-mockup.pdf",
          artifactVersionContentType: "application/pdf",
          artifactVersionByteSize: 1234,
          artifactVersionSha256: "sha256-checkout",
        },
      ],
      [version],
    ]);

    const result = await threadScopeVersionService(db).createDraftFromThread(
      "co1",
      "thread1",
      { userId: "u1", isHuman: true },
      { summary: "Draft v1" },
    );

    expect(result).toEqual({ status: "created", version });
    const scopeItemInsert = db.insert.mock.results[1]?.value.values;
    expect(scopeItemInsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "artifact_link",
          title: "Checkout mockup",
          artifactId: "artifact-1",
          artifactVersionId: "artifact-version-1",
          payload: expect.objectContaining({
            role: "reference",
            contentType: "application/pdf",
            storageKind: "asset",
            assetId: "asset-artifact-1",
            filename: "checkout-mockup.pdf",
            byteSize: 1234,
            sha256: "sha256-checkout",
          }),
          sourceEntryIds: ["entry-1"],
        }),
      ]),
    );
  });

  it("guards artifact and asset attachment joins by company", async () => {
    const version = {
      id: "scope1",
      threadId: "thread1",
      versionNumber: 1,
      sourceStartSeq: 1,
      sourceEndSeq: 1,
      status: "draft",
    };
    const db = createSequenceDb([
      [{ id: "thread1", companyId: "co1", subtype: "normal", entrySeq: 1 }],
      [],
      [
        {
          id: "entry-1",
          discussionId: "thread1",
          seq: 1,
          inputType: "write",
          rawContent: "Use the attached artifact as the source.",
        },
      ],
      [],
      [],
      [version],
    ]);

    await threadScopeVersionService(db).createDraftFromThread(
      "co1",
      "thread1",
      { userId: "u1", isHuman: true },
      { summary: "Draft v1" },
    );

    const attachmentSelect = db.__selectChains[4];
    expect(attachmentSelect.leftJoin).toHaveBeenCalledTimes(3);
    for (const [, joinCondition] of [
      attachmentSelect.leftJoin.mock.calls[0],
      attachmentSelect.leftJoin.mock.calls[2],
    ]) {
      expect(joinCondition.queryChunks.length).toBeGreaterThan(1);
      expect(sqlConditionContainsColumn(joinCondition, "company_id")).toBe(true);
    }
  });

  it("selects attachment artifact and asset ids from company-guarded joins", async () => {
    const version = {
      id: "scope1",
      threadId: "thread1",
      versionNumber: 1,
      sourceStartSeq: 1,
      sourceEndSeq: 1,
      status: "draft",
    };
    const db = createSequenceDb([
      [{ id: "thread1", companyId: "co1", subtype: "normal", entrySeq: 1 }],
      [],
      [
        {
          id: "entry-1",
          discussionId: "thread1",
          seq: 1,
          inputType: "write",
          rawContent: "Use the attached artifact as the source.",
        },
      ],
      [],
      [
        {
          discussionEntryId: "entry-1",
          rawAttachmentArtifactId: "foreign-artifact",
          rawAttachmentAssetId: "foreign-asset",
          artifactId: null,
          assetId: null,
          artifactVersionId: null,
          artifactTitle: null,
          artifactType: null,
          assetOriginalFilename: null,
          assetContentType: null,
          artifactVersionStorageKind: null,
          artifactVersionAssetId: null,
          artifactVersionFilename: null,
          artifactVersionContentType: null,
          artifactVersionByteSize: null,
          artifactVersionSha256: null,
        },
      ],
      [version],
    ]);

    await threadScopeVersionService(db).createDraftFromThread(
      "co1",
      "thread1",
      { userId: "u1", isHuman: true },
      { summary: "Draft v1" },
    );

    const attachmentSelectShape = db.select.mock.calls[4]?.[0];
    expect(attachmentSelectShape.artifactId).toBe(artifacts.id);
    expect(attachmentSelectShape.assetId).toBe(assets.id);
    expect(attachmentSelectShape.artifactVersionStorageKind).toBe(artifactVersions.storageKind);
    expect(attachmentSelectShape.artifactVersionAssetId).toBe(artifactVersions.assetId);
    expect(attachmentSelectShape.artifactVersionFilename).toBe(artifactVersions.filename);
    expect(attachmentSelectShape.artifactVersionContentType).toBe(artifactVersions.contentType);
    expect(attachmentSelectShape.artifactVersionByteSize).toBe(artifactVersions.byteSize);
    expect(attachmentSelectShape.artifactVersionSha256).toBe(artifactVersions.sha256);

    const scopeItemInsert = db.insert.mock.results[1]?.value.values;
    const insertedItems = scopeItemInsert.mock.calls[0]?.[0] ?? [];
    expect(insertedItems).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactId: "foreign-artifact" }),
        expect.objectContaining({ payload: expect.objectContaining({ assetId: "foreign-asset" }) }),
      ]),
    );
  });

  it("degrades artifact-typed extracted items to evidence source signals", async () => {
    // discussion_extracted_items has no `payload` column, and extraction does not
    // emit artifact ids, so an artifact-typed extracted item becomes an evidence
    // source_signal — never a fabricated artifact_link. Concrete artifact links
    // come only from the attachment join.
    const version = {
      id: "scope1",
      threadId: "thread1",
      versionNumber: 1,
      sourceStartSeq: 1,
      sourceEndSeq: 1,
      status: "draft",
    };
    const db = createSequenceDb([
      [{ id: "thread1", companyId: "co1", subtype: "normal", entrySeq: 1 }],
      [],
      [
        {
          id: "entry-1",
          discussionId: "thread1",
          seq: 1,
          inputType: "write",
          rawContent: "Use the generated design artifact.",
        },
      ],
      [
        {
          id: "extracted-artifact-1",
          discussionEntryId: "entry-1",
          type: "artifact",
          title: "Design artifact",
          description: "Generated checkout design",
          suggestedPriority: null,
          suggestedAssigneeId: null,
          suggestedDepartmentId: null,
          suggestedProjectId: null,
          suggestedLayer: null,
          suggestedGoalId: null,
          status: "pending",
        },
      ],
      [],
      [version],
    ]);

    const result = await threadScopeVersionService(db).createDraftFromThread(
      "co1",
      "thread1",
      { userId: "u1", isHuman: true },
      { summary: "Draft v1" },
    );

    expect(result).toEqual({ status: "created", version });
    const scopeItemInsert = db.insert.mock.results[1]?.value.values;
    const insertedItems = scopeItemInsert.mock.calls[0]?.[0] ?? [];
    expect(insertedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "source_signal",
          title: "Design artifact",
          extractedItemId: "extracted-artifact-1",
          sourceEntryIds: ["entry-1"],
          payload: expect.objectContaining({ role: "evidence", category: "artifact" }),
        }),
      ]),
    );
    // No fabricated artifact_link is produced for the extracted artifact item.
    expect(insertedItems).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "artifact_link", artifactId: "artifact1" }),
      ]),
    );
  });

  it("creates v2 draft starting after the latest accepted sourceEndSeq", async () => {
    const latest = {
      id: "scope1",
      threadId: "thread1",
      versionNumber: 1,
      sourceEndSeq: 5,
      status: "accepted",
    };
    const version = {
      id: "scope2",
      threadId: "thread1",
      versionNumber: 2,
      sourceStartSeq: 6,
      sourceEndSeq: 7,
      status: "draft",
    };
    const db = createSequenceDb([
      [{ id: "thread1", companyId: "co1", subtype: "normal", entrySeq: 7 }],
      [latest],
      [
        { id: "entry-6", discussionId: "thread1", seq: 6, inputType: "write", rawContent: "New discussion after v1." },
        { id: "entry-7", discussionId: "thread1", seq: 7, inputType: "write", rawContent: "Create v2 scope from this range." },
      ],
      [],
      [],
      [version],
    ]);

    const result = await threadScopeVersionService(db).createDraftFromThread(
      "co1",
      "thread1",
      { userId: "u1", isHuman: true },
      { summary: "Draft v2" },
    );

    expect(result).toEqual({ status: "created", version });
  });

  it("returns existing active draft instead of creating a duplicate", async () => {
    const draft = {
      id: "scope1",
      threadId: "thread1",
      versionNumber: 1,
      sourceEndSeq: 2,
      status: "draft",
    };
    const db = createSequenceDb([
      [{ id: "thread1", companyId: "co1", subtype: "normal", entrySeq: 2 }],
      [draft],
    ]);

    const result = await threadScopeVersionService(db).createDraftFromThread(
      "co1",
      "thread1",
      { userId: "u1", isHuman: true },
      { summary: "Draft v1" },
    );

    expect(result).toEqual({ status: "existing_draft", version: draft });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("only selects pending, unresolved extracted items when compiling a draft", async () => {
    // Defect (a): re-running draft creation must not re-map already-resolved
    // extracted items, so the select must scope to pending + null result links.
    const db = createSequenceDb([
      [{ id: "thread1", companyId: "co1", subtype: "normal", entrySeq: 1 }],
      [],
      [{ id: "entry-1", discussionId: "thread1", seq: 1, inputType: "write", rawContent: "Scope this." }],
      [],
      [],
      [{ id: "scope1", threadId: "thread1", versionNumber: 1, sourceStartSeq: 1, sourceEndSeq: 1, status: "draft" }],
    ]);

    await threadScopeVersionService(db).createDraftFromThread(
      "co1",
      "thread1",
      { userId: "u1", isHuman: true },
      { summary: "Draft v1" },
    );

    // selectChains[3] is the discussion_extracted_items query.
    const extractedSelect = db.__selectChains[3];
    const whereArg = extractedSelect.where.mock.calls[0]?.[0];
    expect(sqlConditionContainsColumn(whereArg, "status")).toBe(true);
    expect(sqlConditionContainsColumn(whereArg, "result_task_id")).toBe(true);
    expect(sqlConditionContainsColumn(whereArg, "result_memory_id")).toBe(true);
  });

  it("includes pending AND edited unresolved items, excludes resolved ones", async () => {
    // The dedup filter must select both `pending` and `edited` extracted items
    // (both are actionable / unresolved). An item the founder lightly edited
    // before the draft compile must not silently vanish from the scope draft.
    const version = {
      id: "scope1",
      threadId: "thread1",
      versionNumber: 1,
      sourceStartSeq: 1,
      sourceEndSeq: 1,
      status: "draft",
    };
    const db = createSequenceDb([
      [{ id: "thread1", companyId: "co1", subtype: "normal", entrySeq: 1 }],
      [],
      [{ id: "entry-1", discussionId: "thread1", seq: 1, inputType: "write", rawContent: "Scope this work." }],
      // Extracted-items select: the real query filters status IN (pending, edited)
      // + null result links, so the mock returns exactly those rows.
      [
        {
          id: "extracted-pending",
          discussionEntryId: "entry-1",
          type: "task",
          title: "Pending task item",
          description: "Still pending.",
          suggestedPriority: null,
          suggestedAssigneeId: null,
          suggestedDepartmentId: null,
          suggestedProjectId: null,
          suggestedLayer: null,
          suggestedGoalId: null,
          status: "pending",
          resultTaskId: null,
          resultMemoryId: null,
        },
        {
          id: "extracted-edited",
          discussionEntryId: "entry-1",
          type: "task",
          title: "Edited task item",
          description: "Founder lightly edited this.",
          suggestedPriority: null,
          suggestedAssigneeId: null,
          suggestedDepartmentId: null,
          suggestedProjectId: null,
          suggestedLayer: null,
          suggestedGoalId: null,
          status: "edited",
          resultTaskId: null,
          resultMemoryId: null,
        },
      ],
      [],
      [version],
    ]);

    const result = await threadScopeVersionService(db).createDraftFromThread(
      "co1",
      "thread1",
      { userId: "u1", isHuman: true },
      { summary: "Draft v1" },
    );

    expect(result).toEqual({ status: "created", version });

    // The dedup filter must enumerate BOTH actionable statuses.
    const extractedSelect = db.__selectChains[3];
    const whereArg = extractedSelect.where.mock.calls[0]?.[0];
    expect(sqlConditionContainsValue(whereArg, "pending")).toBe(true);
    expect(sqlConditionContainsValue(whereArg, "edited")).toBe(true);

    // Both items flow through into the compiled scope items.
    const scopeItemInsert = db.insert.mock.results[1]?.value.values;
    const insertedItems = scopeItemInsert?.mock.calls[0]?.[0] ?? [];
    expect(insertedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ extractedItemId: "extracted-pending" }),
        expect.objectContaining({ extractedItemId: "extracted-edited" }),
      ]),
    );
  });

  it("skips already-resolved extracted items when compiling scope items (defense-in-depth)", async () => {
    const version = {
      id: "scope1",
      threadId: "thread1",
      versionNumber: 1,
      sourceStartSeq: 1,
      sourceEndSeq: 1,
      status: "draft",
    };
    const db = createSequenceDb([
      [{ id: "thread1", companyId: "co1", subtype: "normal", entrySeq: 1 }],
      [],
      [{ id: "entry-1", discussionId: "thread1", seq: 1, inputType: "write", rawContent: "Already-handled task." }],
      [
        {
          id: "resolved-task-item",
          discussionEntryId: "entry-1",
          type: "task",
          title: "Already created task",
          description: "This already produced a task.",
          status: "approved",
          resultTaskId: "task-existing",
          resultMemoryId: null,
        },
      ],
      [],
      [version],
    ]);

    const result = await threadScopeVersionService(db).createDraftFromThread(
      "co1",
      "thread1",
      { userId: "u1", isHuman: true },
      { summary: "Draft v1" },
    );

    expect(result).toEqual({ status: "created", version });
    const scopeItemInsert = db.insert.mock.results[1]?.value.values;
    const insertedItems = scopeItemInsert?.mock.calls[0]?.[0] ?? [];
    // The resolved extracted item must not be re-mapped into a fresh proposal card.
    expect(insertedItems).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ extractedItemId: "resolved-task-item" }),
      ]),
    );
  });

  it("returns the existing draft when a concurrent insert hits the one-draft unique index", async () => {
    // Minor: concurrent createDraft can race past the latest-draft guard and lose
    // the one-draft partial unique index. The 23505 must become the existing draft,
    // not a 500.
    const thread = { id: "thread1", companyId: "co1", subtype: "normal", entrySeq: 1 };
    const winningDraft = {
      id: "scope-winner",
      threadId: "thread1",
      versionNumber: 1,
      sourceEndSeq: 1,
      status: "draft",
    };

    let latestReloads = 0;
    const selectQueue: any[][] = [
      [thread], // thread lookup
      [], // loadLatestScopeVersion (first call) — no existing version
      [{ id: "entry-1", discussionId: "thread1", seq: 1, inputType: "write", rawContent: "Scope this." }],
      [], // extracted items
      [], // attachments
    ];
    let idx = 0;

    function makeSelectChain() {
      const chain: any = {
        from: vi.fn(() => chain),
        leftJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (rows: any[]) => any) => {
          // After the queue is exhausted, the post-violation loadLatestScopeVersion
          // returns the winning draft.
          if (idx >= selectQueue.length) {
            latestReloads += 1;
            return Promise.resolve(selectQueue[idx] ?? []).then(() => resolve([winningDraft]));
          }
          return Promise.resolve(selectQueue[idx++] ?? []).then(resolve);
        },
      };
      return chain;
    }

    const uniqueErr = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint: "thread_scope_versions_one_draft_uq",
    });

    const db: any = {
      select: vi.fn(() => makeSelectChain()),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => {
            throw uniqueErr;
          }),
        })),
      })),
      transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(db)),
    };

    const result = await threadScopeVersionService(db).createDraftFromThread(
      "co1",
      "thread1",
      { userId: "u1", isHuman: true },
      { summary: "Draft v1" },
    );

    expect(result).toEqual({ status: "existing_draft", version: winningDraft });
    expect(latestReloads).toBeGreaterThan(0);
  });

  it("returns the existing draft when a concurrent insert hits the thread-version unique index", async () => {
    // A-M18: two racers that both clear the latest-draft guard insert
    // versionNumber = latest+1 with status = "draft", violating BOTH
    // thread_scope_versions_thread_version_uq (threadId, versionNumber) AND
    // thread_scope_versions_one_draft_uq (threadId WHERE status='draft').
    // The migration creates thread_version_uq first, so Postgres reports it
    // FIRST. The catch must converge on EITHER index, not re-throw a 500.
    const thread = { id: "thread1", companyId: "co1", subtype: "normal", entrySeq: 1 };
    const winningDraft = {
      id: "scope-winner",
      threadId: "thread1",
      versionNumber: 1,
      sourceEndSeq: 1,
      status: "draft",
    };

    let latestReloads = 0;
    const selectQueue: any[][] = [
      [thread], // thread lookup
      [], // loadLatestScopeVersion (first call) — no existing version
      [{ id: "entry-1", discussionId: "thread1", seq: 1, inputType: "write", rawContent: "Scope this." }],
      [], // extracted items
      [], // attachments
    ];
    let idx = 0;

    function makeSelectChain() {
      const chain: any = {
        from: vi.fn(() => chain),
        leftJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (rows: any[]) => any) => {
          // After the queue is exhausted, the post-violation loadLatestScopeVersion
          // returns the winning draft.
          if (idx >= selectQueue.length) {
            latestReloads += 1;
            return Promise.resolve(selectQueue[idx] ?? []).then(() => resolve([winningDraft]));
          }
          return Promise.resolve(selectQueue[idx++] ?? []).then(resolve);
        },
      };
      return chain;
    }

    // Postgres reports the FIRST-created index (thread_version_uq) on conflict.
    const uniqueErr = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint: "thread_scope_versions_thread_version_uq",
    });

    const db: any = {
      select: vi.fn(() => makeSelectChain()),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => {
            throw uniqueErr;
          }),
        })),
      })),
      transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(db)),
    };

    const result = await threadScopeVersionService(db).createDraftFromThread(
      "co1",
      "thread1",
      { userId: "u1", isHuman: true },
      { summary: "Draft v1" },
    );

    expect(result).toEqual({ status: "existing_draft", version: winningDraft });
    expect(latestReloads).toBeGreaterThan(0);
  });
});
