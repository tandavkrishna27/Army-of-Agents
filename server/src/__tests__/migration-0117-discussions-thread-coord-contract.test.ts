import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_PATH = resolve(
  __dirname,
  "../../../packages/db/src/migrations/0117_icy_lenny_balinger.sql",
);

const SNAPSHOT_0117_PATH = resolve(
  __dirname,
  "../../../packages/db/src/migrations/meta/0117_snapshot.json",
);

describe("Migration 0117 — discussions thread-native coordination columns (Task A2)", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("adds the four scalar coordination columns", () => {
    expect(sql).toMatch(
      /ALTER TABLE "discussions" ADD COLUMN "share_token" text/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE "discussions" ADD COLUMN "slack_channel_id" text/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE "discussions" ADD COLUMN "allow_memory_extraction" boolean DEFAULT true NOT NULL/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE "discussions" ADD COLUMN "adjutant_enabled" boolean DEFAULT true NOT NULL/i,
    );
  });

  it("adds the summary_embedding column only when pgvector is installed", () => {
    // Must be wrapped in a pgvector-gated DO block (mirrors 0038 pattern) so
    // embedded-postgres doesn't blow up on the unknown `vector(1536)` type.
    expect(sql).toMatch(
      /IF EXISTS \(SELECT 1 FROM pg_extension WHERE extname = 'vector'\)[\s\S]+ADD COLUMN "summary_embedding" vector\(1536\)/i,
    );
    expect(sql).toMatch(/EXCEPTION WHEN duplicate_column/i);
  });

  it("makes share_token unique", () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "discussions_share_token_unique" UNIQUE\("share_token"\)/i,
    );
  });

  it("canonicalizes thread visibility defaults to 'company'", () => {
    expect(sql).toMatch(
      /ALTER TABLE "discussions" ALTER COLUMN "visibility" SET DEFAULT 'company'/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE "projects" ALTER COLUMN "default_thread_visibility" SET DEFAULT 'company'/i,
    );
  });

  it("backfills legacy 'open' visibility rows to 'company'", () => {
    expect(sql).toMatch(
      /UPDATE "discussions" SET "visibility" = 'company' WHERE "visibility" = 'open'/i,
    );
    expect(sql).toMatch(
      /UPDATE "projects" SET "default_thread_visibility" = 'company' WHERE "default_thread_visibility" = 'open'/i,
    );
  });

  it("creates a defensive HNSW index inside a DO/EXCEPTION block (0083/0115 pattern)", () => {
    // The HNSW index must be wrapped so pgvector-less environments
    // (embedded-postgres, vanilla CI Postgres) just log a NOTICE and continue.
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "discussions_summary_embedding_hnsw_idx"[\s\S]+USING hnsw \("summary_embedding" vector_cosine_ops\)/i,
    );
    expect(sql).toMatch(/EXCEPTION[\s\S]+WHEN OTHERS THEN[\s\S]+RAISE NOTICE/i);
  });

  it("runs the HNSW index creation AFTER the column adds", () => {
    const columnAddIdx = sql.search(/ADD COLUMN "summary_embedding"/i);
    const indexCreationIdx = sql.search(/discussions_summary_embedding_hnsw_idx/i);
    expect(columnAddIdx).toBeGreaterThanOrEqual(0);
    expect(indexCreationIdx).toBeGreaterThanOrEqual(0);
    expect(columnAddIdx).toBeLessThan(indexCreationIdx);
  });
});

describe("Migration 0117 snapshot — Drizzle metadata captures the new schema", () => {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_0117_PATH, "utf8"));

  function discussionsColumns(): Record<string, unknown> {
    const table =
      snapshot?.tables?.["public.discussions"] ??
      snapshot?.tables?.["discussions"];
    if (!table) throw new Error("discussions table not present in 0117 snapshot");
    return table.columns ?? {};
  }

  it("records all five new column definitions", () => {
    const columns = discussionsColumns();
    expect(columns).toHaveProperty("share_token");
    expect(columns).toHaveProperty("slack_channel_id");
    expect(columns).toHaveProperty("allow_memory_extraction");
    expect(columns).toHaveProperty("adjutant_enabled");
    expect(columns).toHaveProperty("summary_embedding");
  });

  it("records summary_embedding as vector(1536)", () => {
    const columns = discussionsColumns();
    const col = columns["summary_embedding"] as { type?: string } | undefined;
    expect(col?.type).toBe("vector(1536)");
  });
});
