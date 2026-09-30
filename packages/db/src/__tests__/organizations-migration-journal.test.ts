// packages/db/src/__tests__/organizations-migration-journal.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const journal = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; version: string; tag: string; when: number; breakpoints: boolean }> };

const entry = journal.entries.find((e) => e.tag === "0188_organizations");

describe("0188 journal registration", () => {
  it("is registered at idx 188", () => {
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(188);
  });
  it("matches the journal version 7 with breakpoints", () => {
    expect(entry?.version).toBe("7");
    expect(entry?.breakpoints).toBe(true);
  });
  it("0188 `when` sorts strictly after 0187 and before 0189 (Drizzle timestamp-ordered apply)", () => {
    const w = (t: string) => journal.entries.find((e) => e.tag.startsWith(t))!.when;
    expect(w("0188_organizations")).toBeGreaterThan(w("0187"));
    expect(w("0188_organizations")).toBeLessThan(w("0189"));
  });
});
