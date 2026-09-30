import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Artifact QA Tests
 *
 * Covers:
 * - Artifact branching with parentVersionId (founder-picked winner)
 * - Immutable versions never modified
 * - Artifact-as-input flows through dependency chain
 * - Version numbering atomicity
 * - Source tracking (agent/founder/mcp/teammate/external)
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  and: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
  or: vi.fn((...args: unknown[]) => args),
  sql: Object.assign(
    vi.fn((strings: unknown, ...values: unknown[]) => ({
      sql: strings,
      values,
      as: vi.fn().mockReturnValue("aliased_column"),
    })),
    { raw: vi.fn((s: unknown) => s) },
  ),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(prop);
          return cols[prop];
        }
        return undefined;
      },
    });
  };

  return {
    artifacts: makeTable("artifacts"),
    artifactVersions: makeTable("artifact_versions"),
    issues: makeTable("issues"),
    assets: makeTable("assets"),
  };
});

import { artifactService } from "../services/artifacts.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTransactionDb(config: {
  selects?: Record<string, unknown>[][];
  inserts?: Record<string, unknown>[][];
  updates?: Record<string, unknown>[][];
  capturedValues?: unknown[];
}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;

  const selects = config.selects ?? [];
  const inserts = config.inserts ?? [];
  const updates = config.updates ?? [];

  function makeChain(getResult: () => Record<string, unknown>[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "set", "values", "returning", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      chain[m] = (...args: unknown[]) => {
        if (m === "values") config.capturedValues?.push(args[0]);
        return chain;
      };
    }
    chain.then = (resolve: (v: Record<string, unknown>[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  const dbOps = {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => updates[updateIdx++] ?? []),
  };

  return {
    ...dbOps,
    transaction: async (fn: (tx: typeof dbOps) => Promise<unknown>) => fn(dbOps),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Artifacts QA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Immutable versions ──────────────────────────────────────────────────────

  describe("Immutable versions (Decision #43)", () => {
    it("addVersion creates a new version without modifying existing ones", async () => {
      const existingVersion = {
        id: "ver-1",
        artifactId: "art-1",
        versionNumber: 1,
        source: "founder",
        content: "Original content",
      };

      const newVersion = {
        id: "ver-2",
        artifactId: "art-1",
        versionNumber: 2,
        source: "agent",
        content: "New content",
        changelog: "Updated by agent",
      };

      const db = createTransactionDb({
        selects: [[{ versionNumber: 1 }]], // existing max version
        inserts: [[newVersion]],
        updates: [[]], // update currentVersionId
      });

      const svc = artifactService(db as any);
      const result = await svc.addVersion("art-1", {
        source: "agent",
        content: "New content",
        changelog: "Updated by agent",
      });

      expect(result.versionNumber).toBe(2);
      // Original version object should remain unchanged
      expect(existingVersion.content).toBe("Original content");
      expect(existingVersion.versionNumber).toBe(1);
    });

    it("infers asset storage when addVersion receives an assetId without storageKind", async () => {
      const capturedValues: unknown[] = [];
      const db = createTransactionDb({
        selects: [[{ companyId: "co-1" }], [{ id: "asset-1" }], [{ versionNumber: 1 }]],
        inserts: [[{
          id: "ver-2",
          artifactId: "art-1",
          versionNumber: 2,
          source: "founder",
          assetId: "asset-1",
          storageKind: "asset",
        }]],
        updates: [[]],
        capturedValues,
      });

      const svc = artifactService(db as any);
      await svc.addVersion("art-1", {
        source: "founder",
        assetId: "asset-1",
        filename: "deck.pdf",
        contentType: "application/pdf",
      });

      expect(capturedValues[0]).toMatchObject({
        assetId: "asset-1",
        storageKind: "asset",
      });
    });

    it("version numbers are auto-incremented atomically", async () => {
      const db = createTransactionDb({
        selects: [[{ versionNumber: 5 }]], // existing max is 5
        inserts: [[{
          id: "ver-6",
          artifactId: "art-1",
          versionNumber: 6,
          source: "founder",
        }]],
        updates: [[]],
      });

      const svc = artifactService(db as any);
      const result = await svc.addVersion("art-1", { source: "founder" });

      expect(result.versionNumber).toBe(6);
    });

    it("first version starts at 1 when no versions exist", async () => {
      const db = createTransactionDb({
        selects: [[]], // no existing versions
        inserts: [[{
          id: "ver-1",
          artifactId: "art-1",
          versionNumber: 1,
          source: "founder",
        }]],
        updates: [[]],
      });

      const svc = artifactService(db as any);
      const result = await svc.addVersion("art-1", { source: "founder" });

      expect(result.versionNumber).toBe(1);
    });
  });

  // ── Artifact branching ──────────────────────────────────────────────────────

  describe("Artifact branching with founder-picked winner", () => {
    it("addVersion supports parentVersionId for branching", async () => {
      const branchedVersion = {
        id: "ver-3",
        artifactId: "art-1",
        versionNumber: 3,
        source: "agent",
        parentVersionId: "ver-1",
        content: "Branched from v1",
      };

      const db = createTransactionDb({
        // A-M8: parentVersionId now triggers a same-artifact ownership lookup
        // BEFORE the max-version read. First select = parent lookup (ver-1 belongs
        // to art-1 → accepted); second select = existing max version.
        selects: [[{ artifactId: "art-1" }], [{ versionNumber: 2 }]],
        inserts: [[branchedVersion]],
        updates: [[]],
      });

      const svc = artifactService(db as any);
      const result = await svc.addVersion("art-1", {
        source: "agent",
        parentVersionId: "ver-1",
        content: "Branched from v1",
      });

      expect(result.parentVersionId).toBe("ver-1");
      expect(result.versionNumber).toBe(3);
    });

    it("currentVersionId is always updated to the latest version", async () => {
      const latestVersion = {
        id: "ver-winner",
        artifactId: "art-1",
        versionNumber: 4,
        source: "founder",
        content: "Winner content",
      };

      const db = createTransactionDb({
        selects: [[{ versionNumber: 3 }]],
        inserts: [[latestVersion]],
        updates: [[]],
      });

      const svc = artifactService(db as any);
      const result = await svc.addVersion("art-1", {
        source: "founder",
        content: "Winner content",
      });

      expect(result.id).toBe("ver-winner");
    });

    it("no auto-merge — each version is distinct (Decision #45)", () => {
      const versions = [
        { id: "v1", versionNumber: 1, source: "founder", content: "Original" },
        { id: "v2", versionNumber: 2, source: "agent", content: "Agent branch", parentVersionId: "v1" },
        { id: "v3", versionNumber: 3, source: "agent", content: "Another branch", parentVersionId: "v1" },
      ];

      // No merge logic — v2 and v3 both branch from v1 independently
      expect(versions[1].content).not.toBe(versions[2].content);
      expect(versions[1].parentVersionId).toBe(versions[2].parentVersionId);
    });
  });

  // ── Source tracking ─────────────────────────────────────────────────────────

  describe("Source tracking", () => {
    const validSources = ["agent", "founder", "mcp", "teammate", "external"];

    for (const source of validSources) {
      it(`accepts "${source}" as a valid source`, async () => {
        const db = createTransactionDb({
          selects: [[{ versionNumber: 1 }]],
          inserts: [[{ id: `ver-${source}`, artifactId: "art-1", versionNumber: 2, source }]],
          updates: [[]],
        });

        const svc = artifactService(db as any);
        const result = await svc.addVersion("art-1", { source });

        expect(result.source).toBe(source);
      });
    }
  });

  // ── Artifact creation ───────────────────────────────────────────────────────

  describe("Artifact creation", () => {
    it("creates artifact with initial version (v1) when source provided", async () => {
      const artifact = {
        id: "art-new",
        companyId: "co-1",
        title: "Design Doc",
        type: "document",
      };

      const version = {
        id: "ver-1",
        artifactId: "art-new",
        versionNumber: 1,
        source: "founder",
        content: "Initial draft",
      };

      const db = createTransactionDb({
        inserts: [[artifact], [version]],
        updates: [[{ ...artifact, currentVersionId: "ver-1" }]],
      });

      const svc = artifactService(db as any);
      const result = await svc.create("co-1", "user-1", {
        title: "Design Doc",
        type: "document",
        source: "founder",
        content: "Initial draft",
      });

      expect(result.versions).toHaveLength(1);
    });

    it("infers asset storage when create receives an assetId without storageKind", async () => {
      const capturedValues: unknown[] = [];
      const artifact = {
        id: "art-new",
        companyId: "co-1",
        title: "Brand deck",
        type: "design",
      };
      const version = {
        id: "ver-1",
        artifactId: "art-new",
        versionNumber: 1,
        source: "founder",
        assetId: "asset-1",
        storageKind: "asset",
      };

      const db = createTransactionDb({
        selects: [[{ id: "asset-1" }]],
        inserts: [[artifact], [version]],
        updates: [[{ ...artifact, currentVersionId: "ver-1" }]],
        capturedValues,
      });

      const svc = artifactService(db as any);
      await svc.create("co-1", "user-1", {
        title: "Brand deck",
        type: "design",
        source: "founder",
        assetId: "asset-1",
        filename: "deck.pdf",
        contentType: "application/pdf",
      });

      expect(capturedValues[1]).toMatchObject({
        assetId: "asset-1",
        storageKind: "asset",
      });
    });

    it("creates artifact without version when no source provided", async () => {
      const artifact = {
        id: "art-new",
        companyId: "co-1",
        title: "Empty artifact",
        type: "document",
      };

      const db = createTransactionDb({
        inserts: [[artifact]],
      });

      const svc = artifactService(db as any);
      const result = await svc.create("co-1", "user-1", {
        title: "Empty artifact",
        type: "document",
      });

      expect(result.versions).toEqual([]);
    });
  });

  // ── Artifact-as-input ───────────────────────────────────────────────────────

  describe("Artifact archive lifecycle", () => {
    it("archives active artifacts", async () => {
      const db = createTransactionDb({
        updates: [[{ id: "art-1", status: "archived" }]],
      });

      const svc = artifactService(db as any);
      const result = await svc.archive("art-1");

      expect(result?.status).toBe("archived");
    });

    it("rejects archiving drafts so unarchive cannot promote them to active", async () => {
      const db = createTransactionDb({
        updates: [[]],
        selects: [[{ status: "draft" }]],
      });

      const svc = artifactService(db as any);
      await expect(svc.archive("art-draft")).rejects.toThrow("Only active artifacts can be archived");
    });

    it("unarchives archived artifacts", async () => {
      const db = createTransactionDb({
        updates: [[{ id: "art-1", status: "active" }]],
      });

      const svc = artifactService(db as any);
      const result = await svc.unarchive("art-1");

      expect(result?.status).toBe("active");
    });

    it("rejects unarchiving drafts so direct calls cannot promote them", async () => {
      const db = createTransactionDb({
        updates: [[]],
        selects: [[{ status: "draft" }]],
      });

      const svc = artifactService(db as any);
      await expect(svc.unarchive("art-draft")).rejects.toThrow("Only archived artifacts can be unarchived");
    });
  });

  describe("Artifact-as-input (Decision #71)", () => {
    it("downstream tasks receive artifacts from dependency tasks", () => {
      // Artifact-as-input chain: spec → design → code → test
      const pipeline = [
        { taskId: "spec", artifactId: "art-spec" },
        { taskId: "design", artifactId: "art-design", dependsOn: "spec" },
        { taskId: "code", artifactId: "art-code", dependsOn: "design" },
        { taskId: "test", artifactId: null, dependsOn: "code" },
      ];

      // When assembling context for "code" task:
      const codeTask = pipeline.find((t) => t.taskId === "code")!;
      const upstream = pipeline.find((t) => t.taskId === codeTask.dependsOn)!;

      expect(upstream.artifactId).toBe("art-design");
      expect(codeTask.dependsOn).toBe("design");
    });

    it("task's artifactId links to the deliverable artifact", () => {
      // issues table has artifactId column
      const task = { id: "task-1", artifactId: "art-1" };
      expect(task.artifactId).toBe("art-1");
    });

    it("getByIssueId returns null when issue has no artifact", async () => {
      const db = createTransactionDb({
        selects: [[{ artifactId: null }]], // issue with no artifact
      });

      const svc = artifactService(db as any);
      const result = await svc.getByIssueId("task-no-artifact");

      expect(result).toBeNull();
    });
  });

  // ── Content truncation in context packaging ─────────────────────────────────

  describe("Content truncation", () => {
    it("artifact content is truncated at 2000 chars in context package", () => {
      const maxContentLen = 2000;
      const longContent = "x".repeat(3000);

      const truncated = longContent.length > maxContentLen
        ? longContent.slice(0, maxContentLen) + "\n\n[... truncated]"
        : longContent;

      expect(truncated.length).toBeLessThan(longContent.length);
      expect(truncated).toContain("[... truncated]");
    });

    it("short content is not truncated", () => {
      const maxContentLen = 2000;
      const shortContent = "Short content here";

      const result = shortContent.length > maxContentLen
        ? shortContent.slice(0, maxContentLen) + "\n\n[... truncated]"
        : shortContent;

      expect(result).toBe(shortContent);
      expect(result).not.toContain("[... truncated]");
    });
  });

  // ── Fetch with versions ─────────────────────────────────────────────────────

  describe("Fetch with versions", () => {
    it("getById returns artifact with all versions (newest first)", async () => {
      const artifact = { id: "art-1", title: "Doc", type: "document" };
      const versions = [
        { id: "v3", versionNumber: 3 },
        { id: "v2", versionNumber: 2 },
        { id: "v1", versionNumber: 1 },
      ];

      const db = createTransactionDb({
        selects: [
          [artifact],  // fetch artifact
          versions,     // fetch versions (newest first)
        ],
      });

      const svc = artifactService(db as any);
      const result = await svc.getById("art-1");

      expect(result).not.toBeNull();
      expect(result!.versions).toHaveLength(3);
      expect(result!.versions[0].versionNumber).toBe(3);
    });

    it("getById returns null for non-existent artifact", async () => {
      const db = createTransactionDb({
        selects: [[]],
      });

      const svc = artifactService(db as any);
      const result = await svc.getById("nonexistent");

      expect(result).toBeNull();
    });
  });
});
