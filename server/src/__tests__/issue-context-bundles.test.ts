import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  createIssueContextBundle,
  setIssueContextBundleItemIncluded,
} from "../services/issue-context-bundles.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  inserts?: MockRow[][];
  updates?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  const insertValues: unknown[] = [];
  const updateValues: unknown[] = [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "leftJoin", "where", "values", "set", "returning"]) {
      chain[method] = (...args: unknown[]) => {
        if (method === "values") insertValues.push(args[0]);
        return chain;
      };
    }
    chain.then = (resolve: (value: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  const db = {
    select: (..._args: unknown[]) => makeChain(() => config.selects?.[selectIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => config.inserts?.[insertIdx++] ?? []),
    update: (..._args: unknown[]) => {
      const chain = makeChain(() => config.updates?.[updateIdx++] ?? []);
      const originalSet = chain.set;
      chain.set = (...args: unknown[]) => {
        updateValues.push(args[0]);
        return (originalSet as (...inner: unknown[]) => unknown)(...args);
      };
      return chain;
    },
    __insertValues: insertValues,
    __updateValues: updateValues,
  };

  return db;
}

function expectHttpError(err: unknown, status: number, message: string) {
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
  expect((err as Error).message).toContain(message);
}

describe("issue context bundles", () => {
  it("stores a child task bundle with a brief and selected parent attachment", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "parent-issue" }],
        [{ id: "child-issue" }],
        [{ id: "attachment-1" }],
      ],
      inserts: [
        [{ id: "bundle-1", companyId: "company-1", sourceIssueId: "parent-issue", targetIssueId: "child-issue" }],
        [{ id: "item-1", bundleId: "bundle-1", itemType: "attachment", sourceId: "attachment-1" }],
      ],
    });

    const result = await createIssueContextBundle(db as never, {
      companyId: "company-1",
      sourceIssueId: "parent-issue",
      targetIssueId: "child-issue",
      brief: "Use the selected logo reference only.",
      items: [{ type: "attachment", id: "attachment-1", label: "logo.png" }],
      createdByAgentId: "lead-agent",
    });

    expect(result.id).toBe("bundle-1");
    expect(result.items).toHaveLength(1);
    expect(db.__insertValues[0]).toMatchObject({
      companyId: "company-1",
      sourceIssueId: "parent-issue",
      targetIssueId: "child-issue",
      brief: "Use the selected logo reference only.",
      createdByAgentId: "lead-agent",
    });
    expect(db.__insertValues[1]).toEqual([
      expect.objectContaining({
        companyId: "company-1",
        bundleId: "bundle-1",
        itemType: "attachment",
        sourceId: "attachment-1",
        label: "logo.png",
      }),
    ]);
  });

  it("rejects context items from another company", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "parent-issue" }],
        [{ id: "child-issue" }],
        [],
      ],
    });

    await expect(
      createIssueContextBundle(db as never, {
        companyId: "company-1",
        sourceIssueId: "parent-issue",
        targetIssueId: "child-issue",
        items: [{ type: "comment", id: "foreign-comment" }],
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expectHttpError(err, 422, "comment does not belong to this company");
      return true;
    });
  });

  it("rejects unsupported context item types", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "parent-issue" }],
        [{ id: "child-issue" }],
      ],
    });

    await expect(
      createIssueContextBundle(db as never, {
        companyId: "company-1",
        sourceIssueId: "parent-issue",
        targetIssueId: "child-issue",
        items: [{ type: "secret", id: "secret-1" }],
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expectHttpError(err, 422, "Unsupported context item type");
      return true;
    });
  });

  it("enforces a default max of 20 selected context items", async () => {
    const db = createSequenceDb();

    await expect(
      createIssueContextBundle(db as never, {
        companyId: "company-1",
        sourceIssueId: "parent-issue",
        targetIssueId: "child-issue",
        items: Array.from({ length: 21 }, (_, index) => ({
          type: "text",
          label: `item ${index + 1}`,
          metadata: { body: `item ${index + 1}` },
        })),
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expectHttpError(err, 422, "At most 20 context items");
      return true;
    });
  });

  it("stores a discussion-origin scope handoff bundle", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "thread-1" }],
        [{ id: "child-issue" }],
        [{ id: "entry-1" }],
        [{ id: "artifact-1" }],
      ],
      inserts: [
        [{ id: "bundle-1", companyId: "company-1", sourceDiscussionId: "thread-1", targetIssueId: "child-issue" }],
        [
          { id: "item-1", bundleId: "bundle-1", itemType: "discussion_entry", sourceId: "entry-1" },
          { id: "item-2", bundleId: "bundle-1", itemType: "artifact", sourceId: "artifact-1" },
          { id: "item-3", bundleId: "bundle-1", itemType: "url", sourceId: null },
        ],
      ],
    });

    const result = await createIssueContextBundle(db as never, {
      companyId: "company-1",
      sourceDiscussionId: "thread-1",
      sourceKind: "discussion_scope",
      targetIssueId: "child-issue",
      brief: "Use these selected scope sources.",
      items: [
        { type: "discussion_entry", id: "entry-1", label: "Founder request" },
        { type: "artifact", id: "artifact-1", label: "Scope mockup" },
        { type: "url", label: "Reference URL", metadata: { url: "https://example.com/spec" } },
      ],
      createdByUserId: "local-board",
    });

    expect(result.id).toBe("bundle-1");
    expect(result.items).toHaveLength(3);
    expect(db.__insertValues[0]).toMatchObject({
      companyId: "company-1",
      sourceDiscussionId: "thread-1",
      sourceKind: "discussion_scope",
      targetIssueId: "child-issue",
      brief: "Use these selected scope sources.",
      createdByUserId: "local-board",
    });
    expect(db.__insertValues[1]).toEqual([
      expect.objectContaining({ itemType: "discussion_entry", sourceId: "entry-1", label: "Founder request" }),
      expect.objectContaining({ itemType: "artifact", sourceId: "artifact-1", label: "Scope mockup" }),
      expect.objectContaining({
        itemType: "url",
        sourceId: null,
        label: "Reference URL",
        metadata: { url: "https://example.com/spec" },
      }),
    ]);
  });

  it("supports the full scope handoff evidence set without tripping the old 10 item cap", async () => {
    const artifactTypes = ["document", "presentation", "code", "design", "report", "other"];
    const db = createSequenceDb({
      selects: [
        [{ id: "thread-1" }],
        [{ id: "child-issue" }],
        [{ id: "entry-1" }],
        [{ id: "asset-1" }],
        ...artifactTypes.map((type) => [{ id: `artifact-${type}` }]),
      ],
      inserts: [
        [{ id: "bundle-1", companyId: "company-1", sourceDiscussionId: "thread-1", targetIssueId: "child-issue" }],
        [{ id: "context-item-1" }],
      ],
    });

    const items = [
      { type: "discussion_entry", id: "entry-1", label: "Founder requirement" },
      { type: "asset", id: "asset-1", label: "interview-notes.pdf" },
      { type: "url", label: "Reference URL", metadata: { url: "https://example.com/scope-reference" } },
      { type: "text", label: "Scope note", metadata: { body: "Keep the first task narrow." } },
      { type: "text", label: "Second scope note", metadata: { body: "Use the newest design artifact." } },
      ...artifactTypes.map((artifactType) => ({
        type: "artifact",
        id: `artifact-${artifactType}`,
        label: `${artifactType} artifact`,
        metadata: { artifactType },
      })),
    ];

    await createIssueContextBundle(db as never, {
      companyId: "company-1",
      sourceDiscussionId: "thread-1",
      sourceKind: "discussion_scope",
      targetIssueId: "child-issue",
      items,
    });

    expect(db.__insertValues[1]).toEqual(
      expect.arrayContaining(
        artifactTypes.map((artifactType) =>
          expect.objectContaining({
            itemType: "artifact",
            sourceId: `artifact-${artifactType}`,
            metadata: { artifactType },
          }),
        ),
      ),
    );
  });

  it("rejects discussion-origin bundles without a valid source discussion", async () => {
    const db = createSequenceDb({
      selects: [
        [],
        [{ id: "child-issue" }],
      ],
    });

    await expect(
      createIssueContextBundle(db as never, {
        companyId: "company-1",
        sourceDiscussionId: "foreign-thread",
        sourceKind: "discussion_scope",
        targetIssueId: "child-issue",
        items: [{ type: "text", label: "Note", metadata: { body: "hello" } }],
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expectHttpError(err, 422, "sourceDiscussionId does not belong to this company");
      return true;
    });
  });

  it("does not copy or move the source asset or artifact into bundle items", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "parent-issue" }],
        [{ id: "child-issue" }],
        [{ id: "artifact-1" }],
      ],
      inserts: [
        [{ id: "bundle-1" }],
        [{ id: "item-1", sourceId: "artifact-1" }],
      ],
    });

    await createIssueContextBundle(db as never, {
      companyId: "company-1",
      sourceIssueId: "parent-issue",
      targetIssueId: "child-issue",
      items: [{ type: "artifact", id: "artifact-1", label: "brand.md", metadata: { version: 2 } }],
    });

    expect(db.__insertValues[1]).toEqual([
      expect.objectContaining({
        itemType: "artifact",
        sourceId: "artifact-1",
        label: "brand.md",
        metadata: { version: 2 },
      }),
    ]);
    expect(JSON.stringify(db.__insertValues[1])).not.toContain("content");
    expect(JSON.stringify(db.__insertValues[1])).not.toContain("fileUrl");
  });

  it("toggles inclusion only for context items owned by the target task", async () => {
    const db = createSequenceDb({
      selects: [
        [
          {
            id: "item-1",
            metadata: { contentType: "application/pdf" },
            bundleId: "bundle-1",
            targetIssueId: "issue-1",
          },
        ],
      ],
      updates: [
        [
          {
            id: "item-1",
            itemType: "asset",
            sourceId: "asset-1",
            label: "interview-notes.pdf",
            metadata: { contentType: "application/pdf", includeInAgentContext: false },
          },
        ],
      ],
    });

    const result = await setIssueContextBundleItemIncluded(db as never, {
      companyId: "company-1",
      targetIssueId: "issue-1",
      itemId: "item-1",
      included: false,
    });

    expect(result).toMatchObject({
      id: "item-1",
      metadata: { contentType: "application/pdf", includeInAgentContext: false },
    });
    expect(db.__updateValues[0]).toMatchObject({
      metadata: { contentType: "application/pdf", includeInAgentContext: false },
    });
  });

  it("keeps task handoff include/exclude as a board-only route mutation", () => {
    const src = readFileSync(
      resolve(import.meta.dirname ?? __dirname, "../routes/issues.ts"),
      "utf8",
    );
    const routeStart = src.indexOf('router.patch("/issues/:id/context-bundles/items/:itemId"');
    expect(routeStart).toBeGreaterThanOrEqual(0);
    const routeEnd = src.indexOf('router.post("/issues/:id/comments"', routeStart);
    const routeSource = src.slice(routeStart, routeEnd > routeStart ? routeEnd : routeStart + 3000);

    expect(routeSource).toContain("assertBoard(req)");
    expect(routeSource.indexOf("assertBoard(req)")).toBeLessThan(
      routeSource.indexOf("setIssueContextBundleItemIncluded"),
    );
  });
});
