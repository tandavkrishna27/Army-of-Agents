/**
 * Memory data migration
 *
 * Run AFTER applying Drizzle schema migrations (pnpm db:migrate).
 * Idempotent — safe to run multiple times.
 *
 * 1. Backfills `layer` on existing memory_items based on category:
 *    - preference → identity
 *    - decision, context, reference, insight → domain
 *
 * 2. Creates initial memory_item_versions (version 1) for items
 *    that don't yet have a currentVersionId.
 *
 * Usage: DATABASE_URL=... tsx src/migrate-memory.ts
 */

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required");
}

const sql = postgres(url, { max: 1 });

try {
  // Step 1: Backfill layer based on category
  const layerResult = await sql`
    UPDATE memory_items
    SET layer = CASE
      WHEN category = 'preference' THEN 'identity'
      ELSE 'domain'
    END
    WHERE layer IS NULL
  `;
  console.log(`Backfilled layer on ${layerResult.count} memory items`);

  // Step 2: Create initial versions for items without currentVersionId
  const itemsWithoutVersion = await sql<{
    id: string;
    content: string;
    status: string;
    created_by: string;
    created_at: Date;
  }[]>`
    SELECT id, content, status, created_by, created_at
    FROM memory_items
    WHERE current_version_id IS NULL
  `;

  console.log(`Creating initial versions for ${itemsWithoutVersion.length} memory items`);

  for (const item of itemsWithoutVersion) {
    // Map item status to version status
    let versionStatus: string;
    if (item.status === "approved") {
      versionStatus = "approved";
    } else if (item.status === "archived") {
      versionStatus = "archived";
    } else if (item.status === "pending") {
      versionStatus = "pending";
    } else if (item.status === "rejected") {
      versionStatus = "rejected";
    } else {
      // draft → keep as draft for version
      versionStatus = "draft";
    }

    const [version] = await sql<{ id: string }[]>`
      INSERT INTO memory_item_versions (memory_item_id, version_number, content, status, created_by, created_at)
      VALUES (${item.id}, 1, ${item.content}, ${versionStatus}, ${item.created_by}, ${item.created_at})
      RETURNING id
    `;

    await sql`
      UPDATE memory_items
      SET current_version_id = ${version.id}
      WHERE id = ${item.id}
    `;
  }

  console.log("Memory migration complete");
} finally {
  await sql.end();
}
