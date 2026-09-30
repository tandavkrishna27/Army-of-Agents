import { sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { memoryItems } from "@armyofagents/db";
import { getDbCapabilities } from "./db-capabilities.js";

/**
 * Drizzle select-column map for memoryItems that conditionally includes
 * the `embedding` column based on pgvector availability.
 *
 * Use this in place of `.select().from(memoryItems)` so queries don't
 * reference a column that doesn't exist on installs without pgvector.
 *
 * Why: migration 0038_marvelous_vapor.sql creates the embedding column
 * conditionally (only when `pg_extension` contains 'vector'). But the
 * Drizzle schema always references the column, so `SELECT *` generates
 * `SELECT ... embedding ...` which 500s on installs without pgvector.
 */
export function memoryItemsSelection(hasVector?: boolean) {
  const effective = hasVector ?? getDbCapabilities().hasVectorSupport;
  const base = {
    id: memoryItems.id,
    companyId: memoryItems.companyId,
    title: memoryItems.title,
    content: memoryItems.content,
    category: memoryItems.category,
    source: memoryItems.source,
    status: memoryItems.status,
    tags: memoryItems.tags,
    departmentId: memoryItems.departmentId,
    projectId: memoryItems.projectId,
    createdBy: memoryItems.createdBy,
    layer: memoryItems.layer,
    priority: memoryItems.priority,
    visibility: memoryItems.visibility,
    expiresAt: memoryItems.expiresAt,
    conversationId: memoryItems.conversationId,
    goalId: memoryItems.goalId,
    taskId: memoryItems.taskId,
    sourceArtifactId: memoryItems.sourceArtifactId,
    sourceContext: memoryItems.sourceContext,
    accessedAt: memoryItems.accessedAt,
    currentVersionId: memoryItems.currentVersionId,
    embeddingRetries: memoryItems.embeddingRetries,
    // Agent-personal scope + extraction tracking
    agentId: memoryItems.agentId,
    validationCount: memoryItems.validationCount,
    lastValidatedAt: memoryItems.lastValidatedAt,
    pinnedToSkill: memoryItems.pinnedToSkill,
    importJobId: memoryItems.importJobId,
    // Phase 6.0: explorer tree
    folderPath: memoryItems.folderPath,
    lastAccessedByUserId: memoryItems.lastAccessedByUserId,
    founderPinnedToTop: memoryItems.founderPinnedToTop,
    createdAt: memoryItems.createdAt,
    updatedAt: memoryItems.updatedAt,
  };
  return effective ? { ...base, embedding: memoryItems.embedding } : base;
}

// Column-name map (JS property → SQL column) for memory_items. Drizzle does
// not let us introspect this robustly at runtime, so we mirror the schema
// here. Keep in sync with packages/db/src/schema/memory_items.ts.
const MEMORY_COLUMN_MAP: Record<string, string> = {
  id: "id",
  companyId: "company_id",
  title: "title",
  content: "content",
  category: "category",
  source: "source",
  status: "status",
  tags: "tags",
  departmentId: "department_id",
  projectId: "project_id",
  createdBy: "created_by",
  layer: "layer",
  priority: "priority",
  visibility: "visibility",
  expiresAt: "expires_at",
  conversationId: "conversation_id",
  goalId: "goal_id",
  taskId: "task_id",
  sourceArtifactId: "source_artifact_id",
  sourceContext: "source_context",
  accessedAt: "accessed_at",
  currentVersionId: "current_version_id",
  embedding: "embedding",
  embeddingRetries: "embedding_retries",
  // Agent-personal scope + extraction tracking
  agentId: "agent_id",
  validationCount: "validation_count",
  lastValidatedAt: "last_validated_at",
  pinnedToSkill: "pinned_to_skill",
  importJobId: "import_job_id",
  // Phase 6.0: explorer tree
  folderPath: "folder_path",
  lastAccessedByUserId: "last_accessed_by_user_id",
  founderPinnedToTop: "founder_pinned_to_top",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

const SELECT_COLS_NO_EMBEDDING = Object.entries(MEMORY_COLUMN_MAP)
  .filter(([js]) => js !== "embedding")
  .map(([js, col]) => `"${col}" AS "${js}"`)
  .join(", ");
const SELECT_COLS_WITH_EMBEDDING = Object.entries(MEMORY_COLUMN_MAP)
  .map(([js, col]) => `"${col}" AS "${js}"`)
  .join(", ");

/**
 * Build an INSERT into memory_items that lists only the columns we provide,
 * skipping `embedding` entirely when pgvector is unavailable.
 *
 * Why not Drizzle's `.insert(memoryItems).values({...})`? In 0.38.x the
 * query builder enumerates EVERY schema column in the INSERT column list
 * (filling unspecified ones with SQL DEFAULT) so it can guarantee matching
 * slots for ON CONFLICT / RETURNING. When the runtime schema physically
 * lacks the `embedding` column, postgres rejects the statement with
 * `column "embedding" of relation "memory_items" does not exist` — even
 * though we never set a value for it. The helper below emits the insert
 * via a `sql` template so the column list tracks `hasVector`.
 *
 * Caller invariant: `values` must already contain `companyId` and `status`;
 * any fields not in MEMORY_COLUMN_MAP are silently dropped.
 */
export async function buildMemoryInsert(
  db: Db,
  values: Record<string, unknown>,
  hasVector: boolean,
): Promise<Array<typeof memoryItems.$inferSelect>> {
  // JSONB columns need JSON-string serialization with a ::jsonb cast; bare
  // array interpolation in Drizzle's sql template expands to `(v1, v2, ...)`,
  // which becomes invalid `()` syntax for empty arrays.
  const JSONB_COLS = new Set(["tags"]);
  const entries: Array<[string, unknown, boolean]> = [];
  for (const [jsKey, sqlCol] of Object.entries(MEMORY_COLUMN_MAP)) {
    if (jsKey === "embedding" && !hasVector) continue;
    if (jsKey === "id" || jsKey === "createdAt" || jsKey === "updatedAt") continue;
    if (values[jsKey] === undefined) continue;
    const isJsonb = JSONB_COLS.has(sqlCol);
    const rawVal = values[jsKey];
    const preparedVal = isJsonb ? JSON.stringify(rawVal ?? []) : rawVal;
    entries.push([sqlCol, preparedVal, isJsonb]);
  }
  const columnList = entries.map(([col]) => `"${col}"`).join(", ");
  const placeholders = sql.join(
    entries.map(([, val, isJsonb]) => (isJsonb ? sql`${val}::jsonb` : sql`${val}`)),
    sql`, `,
  );
  const returning = hasVector ? SELECT_COLS_WITH_EMBEDDING : SELECT_COLS_NO_EMBEDDING;
  const insertSql = sql`INSERT INTO "memory_items" (${sql.raw(columnList)}) VALUES (${placeholders}) RETURNING ${sql.raw(returning)}`;
  const result = await db.execute(insertSql);
  const rawRows = Array.isArray(result)
    ? (result as unknown as Array<Record<string, unknown>>)
    : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
  // CAVEAT: this is a RAW `db.execute` path. With the postgres.js driver, Drizzle's
  // column type-mapping is bypassed, so timestamp columns (createdAt, updatedAt,
  // expiresAt, accessedAt, lastValidatedAt) come back as STRINGS, not Date — the
  // `$inferSelect` cast below is a lie for those fields. Current callers only read
  // id/title/content (e.g. enqueueMemoryEmbedding), so this is safe today. If a
  // caller ever consumes a timestamp from this result (or passes it into a Drizzle
  // timestamp comparison), coerce it to Date first — see embeddings-row-utils.ts
  // for why (otherwise `.toISOString()` throws on the string).
  return rawRows as unknown as Array<typeof memoryItems.$inferSelect>;
}
