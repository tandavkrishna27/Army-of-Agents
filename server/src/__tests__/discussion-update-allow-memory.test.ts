// server/src/__tests__/discussion-update-allow-memory.test.ts
//
// Phase G3 (T5, D6) — per-thread `allowMemoryExtraction` PATCH plumbing.
// Verifies:
//   1. updateDiscussionSchema accepts boolean true/false.
//   2. updateDiscussionSchema rejects non-boolean values (string, number).
//   3. discussionService.update passes allowMemoryExtraction through to the
//      drizzle update.set(...) call and stamps updatedAt with a fresh Date.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateDiscussionSchema } from "@armyofagents/shared";

// ── Drizzle/db mocks (same pattern as discussions-service.test.ts) ──────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
}));

vi.mock("@armyofagents/db", () => ({
  discussions: {
    id: "discussions_id",
    companyId: "discussions_company_id",
    title: "discussions_title",
    status: "discussions_status",
    scopeType: "discussions_scope_type",
    scopeId: "discussions_scope_id",
    tags: "discussions_tags",
    updatedAt: "discussions_updated_at",
    allowMemoryExtraction: "discussions_allow_memory_extraction",
  },
  discussionEntries: {},
  discussionExtractedItems: {},
  discussionAnnotations: {},
  projects: { id: "projects_id", type: "projects_type", companyId: "projects_company_id" },
  goals: { id: "goals_id" },
}));

vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => {
    const err = new Error(msg);
    (err as any).status = 400;
    return err;
  },
  notFound: (msg: string) => {
    const err = new Error(msg);
    (err as any).status = 404;
    return err;
  },
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => ({
    create: vi.fn().mockResolvedValue({ id: "task-1" }),
  })),
}));

vi.mock("../services/memory.js", () => ({
  memoryService: vi.fn(() => ({
    create: vi.fn().mockResolvedValue({ id: "mem-1" }),
    findSimilarItems: vi.fn().mockResolvedValue([]),
  })),
}));

import { discussionService } from "../services/discussions.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeUpdateDb(returningRows: any[]) {
  const setMock = vi.fn();
  const whereMock = vi.fn();
  const returningMock = vi.fn();
  const thenMock = vi.fn((fn: (rows: any[]) => any) =>
    Promise.resolve(fn(returningRows)),
  );

  const update = vi.fn(() => ({
    set: (...setArgs: any[]) => {
      setMock(...setArgs);
      return {
        where: (...whereArgs: any[]) => {
          whereMock(...whereArgs);
          return {
            returning: () => {
              returningMock();
              return { then: thenMock };
            },
          };
        },
      };
    },
  }));

  return {
    db: { update } as any,
    setMock,
    whereMock,
    returningMock,
  };
}

// ── Validator tests ─────────────────────────────────────────────────────────

describe("updateDiscussionSchema – allowMemoryExtraction", () => {
  it("accepts allowMemoryExtraction: true", () => {
    const result = updateDiscussionSchema.safeParse({
      allowMemoryExtraction: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowMemoryExtraction).toBe(true);
    }
  });

  it("accepts allowMemoryExtraction: false", () => {
    const result = updateDiscussionSchema.safeParse({
      allowMemoryExtraction: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowMemoryExtraction).toBe(false);
    }
  });

  it("treats allowMemoryExtraction as optional (empty body still valid)", () => {
    const result = updateDiscussionSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowMemoryExtraction).toBeUndefined();
    }
  });

  it("rejects a string for allowMemoryExtraction (would 400 at route layer)", () => {
    const result = updateDiscussionSchema.safeParse({
      allowMemoryExtraction: "true",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a number for allowMemoryExtraction", () => {
    const result = updateDiscussionSchema.safeParse({
      allowMemoryExtraction: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects null (use unset to skip; explicit null is not a valid boolean)", () => {
    const result = updateDiscussionSchema.safeParse({
      allowMemoryExtraction: null,
    });
    expect(result.success).toBe(false);
  });

  it("composes with other update fields without conflict", () => {
    const result = updateDiscussionSchema.safeParse({
      visibility: "private",
      allowMemoryExtraction: false,
      tags: ["secret"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowMemoryExtraction).toBe(false);
      expect(result.data.visibility).toBe("private");
    }
  });
});

// ── Service tests ───────────────────────────────────────────────────────────

describe("discussionService.update – allowMemoryExtraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes allowMemoryExtraction: true through to drizzle UPDATE .set(...)", async () => {
    const before = Date.now();
    const { db, setMock } = makeUpdateDb([
      { id: "disc-1", companyId: "co-1", allowMemoryExtraction: true },
    ]);
    const updated = await discussionService(db).update("co-1", "disc-1", {
      allowMemoryExtraction: true,
    });
    const after = Date.now();

    expect(updated).toEqual(
      expect.objectContaining({ id: "disc-1", allowMemoryExtraction: true }),
    );
    expect(setMock).toHaveBeenCalledOnce();
    const setPayload = setMock.mock.calls[0][0];
    expect(setPayload.allowMemoryExtraction).toBe(true);
    // updatedAt is stamped on every update.
    expect(setPayload.updatedAt).toBeInstanceOf(Date);
    const ts = (setPayload.updatedAt as Date).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("passes allowMemoryExtraction: false through to drizzle UPDATE .set(...)", async () => {
    const { db, setMock } = makeUpdateDb([
      { id: "disc-1", companyId: "co-1", allowMemoryExtraction: false },
    ]);
    const updated = await discussionService(db).update("co-1", "disc-1", {
      allowMemoryExtraction: false,
    });

    expect(updated).toEqual(
      expect.objectContaining({ id: "disc-1", allowMemoryExtraction: false }),
    );
    const setPayload = setMock.mock.calls[0][0];
    expect(setPayload.allowMemoryExtraction).toBe(false);
  });

  it("returns null when the discussion row does not exist", async () => {
    const { db } = makeUpdateDb([]);
    const updated = await discussionService(db).update("co-1", "missing", {
      allowMemoryExtraction: false,
    });
    expect(updated).toBeNull();
  });
});
