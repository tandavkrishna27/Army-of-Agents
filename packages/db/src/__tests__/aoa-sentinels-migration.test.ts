import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const sql = readFileSync(join(migrations, "0060_aoa_sentinels.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(migrations, "meta", "_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; tag: string; version: string }>;
};

describe("0060 clean database placeholder", () => {
  it("has no data rewrite and remains registered at its historical index", () => {
    expect(sql.trimEnd().endsWith("SELECT 1;")).toBe(true);
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bALTER\b/i);
    expect(journal.entries.find(({ tag }) => tag === "0060_aoa_sentinels")).toMatchObject({
      idx: 60,
      version: "7",
    });
  });
});
