// packages/db/src/__tests__/migration-journal-contiguity.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(__dirname, "..", "migrations");
const journal = JSON.parse(readFileSync(join(MIG_DIR, "meta", "_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; tag: string }>;
};

describe("migration journal is contiguous, unique, and file-aligned", () => {
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  it("has no duplicate ordinals", () => {
    const seen = new Set<number>();
    for (const e of entries) {
      expect(seen.has(e.idx), `duplicate idx ${e.idx}`).toBe(false);
      seen.add(e.idx);
    }
  });

  it("is contiguous from 0 with no gaps", () => {
    entries.forEach((e, i) => {
      expect(e.idx, `expected idx ${i} at position ${i}, got ${e.idx} (${e.tag})`).toBe(i);
    });
  });

  it("every journal tag has a matching .sql file and vice-versa", () => {
    const sqlFiles = new Set(
      readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")),
    );
    for (const e of entries) {
      expect(sqlFiles.has(e.tag), `journal tag ${e.tag} has no .sql file`).toBe(true);
    }
    expect(sqlFiles.size).toBe(entries.length);
  });

  it("tag ordinal prefix matches its journal idx (zero-padded)", () => {
    for (const e of entries) {
      const prefix = e.tag.slice(0, 4);
      expect(prefix, `tag ${e.tag} prefix != idx ${e.idx}`).toBe(String(e.idx).padStart(4, "0"));
    }
  });
});
