import { describe, expect, it, vi } from "vitest";

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
    companyMemberships: makeTable("company_memberships"),
    companyUserCapabilityDocuments: makeTable("company_user_capability_documents"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  asc: (..._args: unknown[]) => "asc",
  eq: (..._args: unknown[]) => "eq",
}));

import { STANDARD_HUMAN_CAPABILITY_DOCUMENTS } from "@armyofagents/shared";
import { humanCapabilitiesService } from "../services/human-capabilities.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  inserts?: MockRow[][];
  deletes?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let deleteIdx = 0;
  const insertValues: unknown[] = [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.values = (value: unknown) => {
      insertValues.push(value);
      return chain;
    };
    chain.returning = () => chain;
    chain.onConflictDoNothing = () => chain;
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeChain(() => config.selects?.[selectIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => config.inserts?.[insertIdx++] ?? []),
    delete: (..._args: unknown[]) => makeChain(() => config.deletes?.[deleteIdx++] ?? []),
    _insertValues: insertValues,
  };
}

describe("humanCapabilitiesService", () => {
  it("lazily seeds standard capability documents with markdown templates", async () => {
    const seededRows = STANDARD_HUMAN_CAPABILITY_DOCUMENTS.map((doc, index) => ({
      id: `doc-${index}`,
      companyId: "company-1",
      userId: "user-1",
      slug: doc.slug,
      filename: doc.filename,
      title: doc.title,
      kind: doc.kind,
      content: doc.content,
      sortOrder: doc.sortOrder,
      isStandard: true,
      createdAt: new Date("2026-07-08T00:00:00.000Z"),
      updatedAt: new Date("2026-07-08T00:00:00.000Z"),
      createdByUserId: null,
      updatedByUserId: null,
    }));
    const db = createSequenceDb({
      selects: [
        [{ id: "membership-1" }],
        [],
        seededRows,
      ],
    });

    const bundle = await humanCapabilitiesService(db as any).listDocuments("company-1", "user-1");

    expect(db._insertValues).toHaveLength(1);
    expect(db._insertValues[0]).toEqual(
      STANDARD_HUMAN_CAPABILITY_DOCUMENTS.map((doc) => expect.objectContaining({
        companyId: "company-1",
        userId: "user-1",
        slug: doc.slug,
        filename: doc.filename,
        title: doc.title,
        content: doc.content,
        isStandard: true,
      })),
    );
    expect(bundle.documents.map((doc) => doc.filename)).toEqual([
      "resume.md",
      "skills.md",
      "responsibilities.md",
      "preferences.md",
      "availability.md",
      "background.md",
    ]);
    expect(bundle.documents[0]?.content).toContain("## Summary");
  });

  it("does not delete standard capability documents", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "membership-1" }],
        [{ id: "doc-1", companyId: "company-1", userId: "user-1", isStandard: true }],
      ],
    });

    await expect(
      humanCapabilitiesService(db as any).deleteDocument("company-1", "user-1", "doc-1"),
    ).rejects.toThrow("Standard capability documents cannot be deleted");
  });
});
