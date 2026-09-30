import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: any[]) => a),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  desc: vi.fn((c: any) => ({ desc: c })),
  asc: vi.fn((c: any) => ({ asc: c })),
  inArray: vi.fn((c: any, v: any) => ({ inArray: [c, v] })),
  sql: Object.assign((s: any) => ({ sql: s }), {}),
}));
vi.mock("@armyofagents/db", () => ({
  discussions: { id: "d_id", companyId: "d_co" },
  discussionEntries: { id: "de_id", discussionId: "de_disc", authorAgentId: "de_agent", createdAt: "de_created" },
  discussionExtractedItems: { id: "dei_id", discussionEntryId: "dei_entry" },
  discussionAnnotations: { id: "da_id", discussionEntryId: "da_entry" },
  discussionEntryAttachments: {
    id: "dea_id",
    discussionEntryId: "dea_entry",
    assetId: "dea_asset",
    artifactId: "dea_artifact",
  },
  artifacts: { id: "art_id", type: "art_type", title: "art_title", status: "art_status", currentVersionId: "art_current_version_id" },
  artifactVersions: {
    id: "av_id",
    artifactId: "av_artifact_id",
    storageKind: "av_storage_kind",
    filename: "av_filename",
    contentType: "av_content_type",
    byteSize: "av_byte_size",
    assetId: "av_asset_id",
  },
  assets: {
    id: "assets_id",
    contentType: "assets_content_type",
    originalFilename: "assets_original_filename",
    byteSize: "assets_byte_size",
  },
  agents: { id: "ag_id", name: "ag_name", icon: "ag_icon" },
  projects: {}, goals: {},
  threadPlanSteps: { id: "tps_id", threadId: "tps_thread", stepOrder: "tps_order" },
  threadScopeVersions: {
    id: "tsv_id",
    companyId: "tsv_company_id",
    threadId: "tsv_thread_id",
    versionNumber: "tsv_version_number",
    status: "tsv_status",
    sourceEndSeq: "tsv_source_end_seq",
    createdAt: "tsv_created_at",
  },
  threadScopeItems: {
    id: "tsi_id",
    scopeVersionId: "tsi_scope_version_id",
    status: "tsi_status",
  },
  // Phase E batch 2 (T22): thread_participants + auth users (joined in getById)
  threadParticipants: {
    id: "tp_id",
    threadId: "tp_thread",
    principalType: "tp_pt",
    principalId: "tp_pid",
    role: "tp_role",
    addedAt: "tp_at",
    companyId: "tp_co",
  },
  authUsers: { id: "au_id", name: "au_name", email: "au_email" },
  threadOrchestrationState: {
    threadId: "tos_thread_id",
    lastError: "tos_last_error",
    consecutiveCommitFailures: "tos_consecutive_commit_failures",
  },
}));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/issues.js", () => ({ issueService: vi.fn(() => ({})) }));
vi.mock("../services/memory.js", () => ({ memoryService: vi.fn(() => ({})) }));
vi.mock("../errors.js", () => ({
  badRequest: (m: string) => Object.assign(new Error(m), { status: 400 }),
  notFound: (m: string) => Object.assign(new Error(m), { status: 404 }),
}));

import { discussionService } from "../services/discussions.js";

function seqDb(queue: any[][]) {
  let i = 0;
  const sel = () => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn((f: any) => Promise.resolve(f(queue[i++] ?? []))),
  });
  return { select: vi.fn(sel) } as any;
}

beforeEach(() => vi.clearAllMocks());

describe("discussionService.getById — plan steps", () => {
  it("includes ordered planSteps in the thread detail payload", async () => {
    const db = seqDb([
      [{ id: "t1", companyId: "co1", summaryText: "s" }],  // discussion
      [{ entry: { id: "e1", discussionId: "t1", createdAt: "x", authorAgentId: null }, authorAgentName: null, authorAgentAvatar: null }], // entries join
      [{ id: "i1", discussionEntryId: "e1", type: "task", title: "T" }], // items
      [], // annotations
      [], // Phase E2: attachments
      [
        { id: "p1", threadId: "t1", stepOrder: 0, title: "Spec" },
        { id: "p2", threadId: "t1", stepOrder: 1, title: "Build" },
      ], // plan steps
      [], // Phase E batch 2 (T22): participants — empty
    ]);
    const res: any = await discussionService(db).getById("co1", "t1");
    expect(res.planSteps.map((p: any) => p.title)).toEqual(["Spec", "Build"]);
    expect(res.entries[0].extractedItems[0].type).toBe("task");
  });

  it("returns empty planSteps when there are no plan steps", async () => {
    const db = seqDb([
      [{ id: "t1", companyId: "co1" }], // discussion
      [], // entries (empty)
      [], // plan steps (empty, no items so skipped)
      [], // Phase E batch 2 (T22): participants — empty
    ]);
    const res: any = await discussionService(db).getById("co1", "t1");
    expect(res.planSteps).toEqual([]);
  });
});
