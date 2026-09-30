import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  companies: makeTableProxy("companies"),
  memoryItems: makeTableProxy("memory_items"),
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// Since the T9 pgvector-safety fix the backfill writes through `buildMemoryInsert`
// (one row per call, omitting the `embedding` column when the DB has no pgvector)
// rather than a raw `db.insert(...).values(...)`. Stub that helper — its own SQL is
// covered by memory-insert-no-pgvector.test.ts — so this suite stays a unit test of
// the backfill's LOGIC (which fields, idempotency, embedding enqueue), and report no
// pgvector so the helper's callers take the embedding-less branch. enqueueMemoryEmbedding
// is a best-effort side effect (Decision #104); stub it too. vi.hoisted keeps the spies
// reachable from the hoisted vi.mock factories.
const { buildMemoryInsert, enqueueMemoryEmbedding } = vi.hoisted(() => ({
  buildMemoryInsert: vi.fn(),
  enqueueMemoryEmbedding: vi.fn(async () => {}),
}));
vi.mock("../services/memory-projection.js", () => ({ buildMemoryInsert }));
vi.mock("../services/db-capabilities.js", () => ({
  getDbCapabilities: () => ({ hasVectorSupport: false }),
}));
vi.mock("../services/memory-write.js", () => ({ enqueueMemoryEmbedding }));

vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
  planIdentityBackfill,
  backfillIdentityMemory,
  backfillAllCompaniesIdentityMemory,
  IDENTITY_BACKFILL_MARK,
} from "../services/identity-backfill.js";

const MARK = IDENTITY_BACKFILL_MARK;

// One buildMemoryInsert call == one inserted item. Echo the projected values back as
// a single row so applyIdentityBackfill can collect id/title/content.
beforeEach(() => {
  buildMemoryInsert.mockReset();
  buildMemoryInsert.mockImplementation(async (_db: unknown, values: Record<string, unknown>) => [
    { id: `mem-${String(values.title)}`, title: values.title, content: values.content },
  ]);
  enqueueMemoryEmbedding.mockClear();
});

// The projected values objects passed to buildMemoryInsert (one per inserted item).
const insertedValues = (): Array<Record<string, unknown>> =>
  buildMemoryInsert.mock.calls.map((c) => c[1] as Record<string, unknown>);

// ── Pure planner (field → item mapping + idempotency) ──────────────────────

describe("planIdentityBackfill", () => {
  it("plans one identity item per non-empty company field", () => {
    const plan = planIdentityBackfill(
      { vision: "Be the best", mission: "Ship value", values: "Trust" },
      [],
    );
    expect(plan.map((p) => p.title).sort()).toEqual([
      "Company Mission",
      "Company Values",
      "Company Vision",
    ]);
    expect(plan.every((p) => p.layer === "identity" && p.sourceContext === MARK)).toBe(true);
    // content is the trimmed field value.
    expect(plan.find((p) => p.title === "Company Vision")?.content).toBe("Be the best");
  });

  it("skips empty/whitespace fields", () => {
    const plan = planIdentityBackfill({ vision: "V", mission: "  ", values: null }, []);
    expect(plan).toHaveLength(1);
    expect(plan[0].title).toBe("Company Vision");
  });

  it("is idempotent — skips fields already backfilled (marker + title)", () => {
    const plan = planIdentityBackfill(
      { vision: "V", mission: "M", values: null },
      [{ title: "Company Vision", sourceContext: MARK }],
    );
    expect(plan.map((p) => p.title)).toEqual(["Company Mission"]);
  });

  it("ignores identity items lacking the backfill marker (treats them as unrelated)", () => {
    const plan = planIdentityBackfill(
      { vision: "V", mission: null, values: null },
      [{ title: "Company Vision", sourceContext: null }],
    );
    // A hand-authored 'Company Vision' without the marker does not block the backfill.
    expect(plan.map((p) => p.title)).toEqual(["Company Vision"]);
  });
});

// ── DB-backed backfill (first run inserts, second run inserts nothing) ──────

type Row = Record<string, unknown>;

/**
 * Sequence-mock db: select #0 → company fields, select #1 → existing identity
 * items. The write path is the mocked buildMemoryInsert (asserted via
 * insertedValues()), so this mock only needs to satisfy the two reads.
 */
function makeMockDb(opts: { company: Row | null; existing?: Row[] }) {
  let selectCall = 0;
  const updates: Array<Record<string, unknown>> = [];
  const deletes: string[] = [];
  const thenable = (rows: () => Row[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit"]) {
      (c as Record<string, () => unknown>)[m] = () => c;
    }
    (c as { then: (r: (rows: Row[]) => unknown) => Promise<unknown> }).then = (resolve) =>
      Promise.resolve(resolve(rows()));
    return c;
  };
  const db = {
    select: () => {
      const idx = selectCall++;
      return thenable(() =>
        idx === 0 ? (opts.company ? [opts.company] : []) : (opts.existing ?? []),
      );
    },
    update: () => {
      const c: Record<string, unknown> = {};
      c.set = (values: Record<string, unknown>) => {
        updates.push(values);
        return c;
      };
      c.where = () => c;
      c.returning = () => c;
      (c as { then: (r: (rows: Row[]) => unknown) => Promise<unknown> }).then = (resolve) =>
        Promise.resolve(
          resolve([{ id: "mem-updated", title: "Company Vision", content: updates.at(-1)?.content }]),
        );
      return c;
    },
    delete: () => {
      const c: Record<string, unknown> = {};
      c.where = () => {
        deletes.push("deleted");
        return c;
      };
      (c as { then: (r: (rows: Row[]) => unknown) => Promise<unknown> }).then = (resolve) =>
        Promise.resolve(resolve([]));
      return c;
    },
  };
  return { db: db as unknown as Parameters<typeof backfillIdentityMemory>[0], updates, deletes };
}

describe("backfillIdentityMemory", () => {
  it("first run inserts one identity item per non-empty field and enqueues embeddings", async () => {
    const { db } = makeMockDb({
      company: { vision: "V", mission: "M", values: "Val" },
      existing: [],
    });
    const n = await backfillIdentityMemory(db, "co-1");
    expect(n).toBe(3);
    const vals = insertedValues();
    expect(vals).toHaveLength(3);
    expect(vals.map((r) => r.title).sort()).toEqual([
      "Company Mission",
      "Company Values",
      "Company Vision",
    ]);
    // Every inserted row is an approved, company-scoped identity item with the marker.
    expect(
      vals.every(
        (r) =>
          r.layer === "identity" &&
          r.status === "approved" &&
          r.visibility === "company" &&
          r.companyId === "co-1" &&
          r.sourceContext === MARK,
      ),
    ).toBe(true);
    expect(enqueueMemoryEmbedding).toHaveBeenCalledTimes(3);
  });

  it("second run inserts nothing (all fields already backfilled)", async () => {
    const { db } = makeMockDb({
      company: { vision: "V", mission: "M", values: "Val" },
      existing: [
        { id: "v", title: "Company Vision", content: "V", sourceContext: MARK },
        { id: "m", title: "Company Mission", content: "M", sourceContext: MARK },
        { id: "val", title: "Company Values", content: "Val", sourceContext: MARK },
      ],
    });
    const n = await backfillIdentityMemory(db, "co-1");
    expect(n).toBe(0);
    expect(insertedValues()).toHaveLength(0);
  });

  it("inserts only the missing field on a partial re-run", async () => {
    const { db } = makeMockDb({
      company: { vision: "V", mission: "M", values: null },
      existing: [{ id: "v", title: "Company Vision", content: "V", sourceContext: MARK }],
    });
    const n = await backfillIdentityMemory(db, "co-1");
    expect(n).toBe(1);
    expect(insertedValues().map((r) => r.title)).toEqual(["Company Mission"]);
  });

  it("empty fields insert nothing (never touches memory_items)", async () => {
    const { db } = makeMockDb({
      company: { vision: null, mission: "   ", values: "" },
    });
    const n = await backfillIdentityMemory(db, "co-1");
    expect(n).toBe(0);
    expect(insertedValues()).toHaveLength(0);
  });

  it("returns 0 for a missing company", async () => {
    const { db } = makeMockDb({ company: null });
    const n = await backfillIdentityMemory(db, "nope");
    expect(n).toBe(0);
    expect(insertedValues()).toHaveLength(0);
  });

  it("updates a marked identity item when the company field changes", async () => {
    const { db, updates } = makeMockDb({
      company: { vision: "New vision", mission: null, values: null },
      existing: [{ id: "v", title: "Company Vision", content: "Old vision", sourceContext: MARK }],
    });
    expect(await backfillIdentityMemory(db, "co-1")).toBe(1);
    expect(updates).toEqual([expect.objectContaining({ content: "New vision" })]);
    expect(enqueueMemoryEmbedding).toHaveBeenCalledWith(
      db,
      "co-1",
      expect.objectContaining({ content: "New vision" }),
    );
  });

  it("deletes the marked identity item when its company field is cleared", async () => {
    const { db, deletes } = makeMockDb({
      company: { vision: null, mission: null, values: null },
      existing: [{ id: "v", title: "Company Vision", content: "Old vision", sourceContext: MARK }],
    });
    expect(await backfillIdentityMemory(db, "co-1")).toBe(1);
    expect(deletes).toHaveLength(1);
    expect(insertedValues()).toHaveLength(0);
  });
});

// ── All-companies startup loop ─────────────────────────────────────────────

describe("backfillAllCompaniesIdentityMemory", () => {
  it("aggregates inserts across companies and skips empty ones", async () => {
    // select #0 = all companies; then per company with content: select existing.
    const companyRows: Row[] = [
      { id: "co-1", vision: "V1", mission: null, values: null },
      { id: "co-2", vision: null, mission: null, values: null }, // no content → skipped
    ];
    let selectCall = 0;
    const thenable = (rows: () => Row[]) => {
      const c: Record<string, unknown> = {};
      for (const m of ["from", "where", "orderBy", "limit"]) {
        (c as Record<string, () => unknown>)[m] = () => c;
      }
      (c as { then: (r: (rows: Row[]) => unknown) => Promise<unknown> }).then = (resolve) =>
        Promise.resolve(resolve(rows()));
      return c;
    };
    const db = {
      select: () => {
        const idx = selectCall++;
        // idx 0 = companies list; idx 1 = existing identity items for co-1 (only company with content).
        return thenable(() => (idx === 0 ? companyRows : []));
      },
    } as unknown as Parameters<typeof backfillAllCompaniesIdentityMemory>[0];

    const res = await backfillAllCompaniesIdentityMemory(db);
    expect(res).toEqual({ companies: 1, items: 1 });
    const vals = insertedValues();
    expect(vals).toHaveLength(1);
    expect(vals[0].title).toBe("Company Vision");
  });
});
