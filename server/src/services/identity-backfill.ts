/**
 * Idempotent backfill of company identity (vision/mission/values) into
 * `layer='identity'` memory items (enterprise memory model, P1-T9).
 *
 * Goal: make identity-layer memory the single home for company vision/mission/
 * values, WITHOUT breaking today's `companies`-fields readers — the `companies`
 * columns remain the temporary mirror (never dropped here). Identity reads
 * already include these items via searchMultiPath's `layer='identity'` path, so
 * no retrieval rewrite is needed; the backfilled rows appear as normal approved
 * identity memory in the Memory UI.
 *
 * Idempotency is keyed on a stable marker: an identity item is considered
 * "already backfilled" when it carries `sourceContext = "company:identity"` AND
 * matches the field's title. Safe to run repeatedly — a second run inserts 0
 * rows (mirrors the `backfillCrewTemplateOrigin` / `backfillMemoryFolderSeeds`
 * startup-backfill contract). The all-companies entry point is wired into the
 * boot path in `server/src/index.ts`; the per-company entry point is invoked
 * best-effort on the company general-settings save (`routes/companies.ts`).
 */
import { and, eq } from "drizzle-orm";
import { companies, memoryItems, type Db } from "@armyofagents/db";
import { enqueueMemoryEmbedding } from "./memory-write.js";
import { buildMemoryInsert } from "./memory-projection.js";
import { getDbCapabilities } from "./db-capabilities.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "identity-backfill" });

/** Stable marker distinguishing backfill-created identity items from hand-authored ones. */
export const IDENTITY_BACKFILL_MARK = "company:identity";

export interface CompanyIdentityFields {
  vision: string | null;
  mission: string | null;
  values: string | null;
}

export interface IdentityPlanItem {
  title: string;
  content: string;
  layer: "identity";
  sourceContext: string;
}

/**
 * Pure planner: decide which identity items to insert for a company's fields,
 * given the identity items that already exist. Idempotent — a field whose title
 * already exists as a marked identity item is skipped; empty/whitespace-only
 * fields are skipped. This is the unit-tested core of the backfill.
 */
export function planIdentityBackfill(
  fields: CompanyIdentityFields,
  existing: Array<{ title: string; sourceContext: string | null }>,
): IdentityPlanItem[] {
  const already = new Set(
    existing.filter((e) => e.sourceContext === IDENTITY_BACKFILL_MARK).map((e) => e.title),
  );
  const rows: Array<[string, string | null]> = [
    ["Company Vision", fields.vision],
    ["Company Mission", fields.mission],
    ["Company Values", fields.values],
  ];
  return rows
    .filter(
      ([title, val]) =>
        typeof val === "string" && val.trim().length > 0 && !already.has(title),
    )
    .map(([title, val]) => ({
      title,
      content: (val as string).trim(),
      layer: "identity" as const,
      sourceContext: IDENTITY_BACKFILL_MARK,
    }));
}

/**
 * Core apply step shared by the per-company and all-companies entry points.
 * Given already-fetched identity fields, load existing identity items, plan the
 * insert, write the missing rows as approved company-scoped identity memory, and
 * enqueue embeddings (best-effort, no-op without pgvector — Decision #104: every
 * memory write path enqueues an embedding). Returns the number of rows inserted.
 */
async function applyIdentityBackfill(
  db: Db,
  companyId: string,
  fields: CompanyIdentityFields,
): Promise<number> {
  const existing = await db
    .select({
      id: memoryItems.id,
      title: memoryItems.title,
      content: memoryItems.content,
      sourceContext: memoryItems.sourceContext,
    })
    .from(memoryItems)
    .where(and(eq(memoryItems.companyId, companyId), eq(memoryItems.layer, "identity")));

  const plan = planIdentityBackfill(fields, existing);
  const markedByTitle = new Map(
    existing
      .filter((row) => row.sourceContext === IDENTITY_BACKFILL_MARK)
      .map((row) => [row.title, row] as const),
  );
  const desired = new Map<string, string | null>([
    ["Company Vision", fields.vision?.trim() || null],
    ["Company Mission", fields.mission?.trim() || null],
    ["Company Values", fields.values?.trim() || null],
  ]);
  let changed = 0;

  // Keep existing mirror rows synchronized with edits and removals.
  for (const [title, content] of desired) {
    const current = markedByTitle.get(title);
    if (!current) continue;
    if (content === null) {
      await db.delete(memoryItems).where(eq(memoryItems.id, current.id));
      changed += 1;
      continue;
    }
    if (current.content !== content) {
      const row = await db
        .update(memoryItems)
        .set({ content, updatedAt: new Date() })
        .where(eq(memoryItems.id, current.id))
        .returning({ id: memoryItems.id, title: memoryItems.title, content: memoryItems.content })
        .then((rows) => rows[0] ?? null);
      if (row) {
        changed += 1;
        await enqueueMemoryEmbedding(db, companyId, row).catch(() => {});
      }
    }
  }

  if (plan.length === 0) return changed;

  // Use the pgvector-safe insert helper: on installs without the pgvector
  // extension, memory_items has no `embedding` column, and a plain
  // `db.insert(memoryItems)` enumerates it and fails. `buildMemoryInsert`
  // omits `embedding` when hasVector is false (same path the normal
  // memory-create flow uses). One row per call, so loop the plan.
  const hasVector = getDbCapabilities().hasVectorSupport;
  const inserted: Array<{ id: string; title: string; content: string }> = [];
  for (const p of plan) {
    const rows = await buildMemoryInsert(
      db,
      {
        companyId,
        title: p.title,
        content: p.content,
        category: "context",
        source: "founder",
        status: "approved",
        layer: p.layer,
        visibility: "company",
        createdBy: "system",
        sourceContext: p.sourceContext,
      },
      hasVector,
    );
    const row = rows[0];
    if (row) {
      inserted.push({
        id: row.id as string,
        title: row.title as string,
        content: row.content as string,
      });
    }
  }

  // Index for semantic retrieval (best-effort; enqueueMemoryEmbedding no-ops
  // without pgvector and never throws).
  for (const row of inserted) {
    await enqueueMemoryEmbedding(db, companyId, row).catch(() => {});
  }

  return changed + inserted.length;
}

/**
 * Per-company backfill. Reads the company's vision/mission/values and ensures a
 * marked `layer='identity'` memory item exists for each non-empty field.
 * Returns the number of items inserted (0 if none / already backfilled / no such
 * company). Invoked best-effort from the company general-settings save handler.
 */
export async function backfillIdentityMemory(db: Db, companyId: string): Promise<number> {
  const company = await db
    .select({
      vision: companies.vision,
      mission: companies.mission,
      values: companies.values,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((r) => r[0] ?? null);
  if (!company) return 0;
  return applyIdentityBackfill(db, companyId, company);
}

/**
 * Startup backfill: ensure every company with non-empty vision/mission/values
 * has the corresponding identity memory items. Loops all companies (like
 * `backfillMemoryFolderSeeds`) and is idempotent — a second boot inserts 0 rows.
 * Wired into `server/src/index.ts`.
 */
export async function backfillAllCompaniesIdentityMemory(
  db: Db,
): Promise<{ companies: number; items: number }> {
  const rows = await db
    .select({
      id: companies.id,
      vision: companies.vision,
      mission: companies.mission,
      values: companies.values,
    })
    .from(companies);

  let touched = 0;
  let items = 0;
  for (const row of rows) {
    try {
      const n = await applyIdentityBackfill(db, row.id, row);
      if (n > 0) {
        touched += 1;
        items += n;
      }
    } catch (err) {
      // Best-effort per company — one bad row must not abort the whole backfill.
      log.warn(
        { err: err instanceof Error ? err.message : String(err), companyId: row.id },
        "identity backfill failed for company (skipped)",
      );
    }
  }
  return { companies: touched, items };
}
