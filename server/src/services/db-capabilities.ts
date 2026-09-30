import { sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "db-capabilities" });

export interface DbCapabilities {
  /**
   * True when the pgvector extension is installed on the connected database.
   * When false, the memory_items.embedding column does not exist (migration
   * 0038 creates it conditionally), so every query against memoryItems must
   * omit the embedding field and semantic-search code paths must fall back
   * to text search.
   */
  hasVectorSupport: boolean;
}

// Safe default: assume no pgvector until the probe runs. This keeps the first
// few queries after server boot (before probeDbCapabilities resolves) safe.
let capabilities: DbCapabilities = { hasVectorSupport: false };

export function getDbCapabilities(): DbCapabilities {
  return capabilities;
}

export function setDbCapabilities(next: DbCapabilities): void {
  capabilities = next;
}

/**
 * Probe the database for extensions we optionally depend on.
 * Safe to call multiple times — never throws.
 */
export async function probeDbCapabilities(db: Db): Promise<DbCapabilities> {
  let hasVectorSupport = false;
  try {
    const rows = (await db.execute(
      sql`SELECT 1 AS present FROM pg_extension WHERE extname = 'vector'`,
    )) as unknown as { rowCount?: number; length?: number };
    const count =
      typeof rows.rowCount === "number"
        ? rows.rowCount
        : Array.isArray(rows)
          ? (rows as unknown[]).length
          : 0;
    hasVectorSupport = count > 0;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "pgvector probe failed; assuming extension is unavailable",
    );
    hasVectorSupport = false;
  }

  const next: DbCapabilities = { hasVectorSupport };
  setDbCapabilities(next);

  if (hasVectorSupport) {
    log.info("pgvector extension detected; semantic search enabled");
  } else {
    log.warn(
      "pgvector extension not available; Memory works but semantic search falls back to text (ilike)",
    );
  }

  return next;
}
