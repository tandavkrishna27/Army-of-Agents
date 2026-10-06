import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { companyImportOperations } from "../schema/company_import_operations.js";

describe("company import operation journal", () => {
  it("defines company and organization operation identities and safe checkpoint defaults", () => {
    const config = getTableConfig(companyImportOperations);
    expect(config.indexes.filter((index) => index.config.unique).map((index) => index.config.name))
      .toEqual(["company_import_operations_company_operation_uq", "company_import_operations_org_operation_uq"]);
    expect(companyImportOperations.checkpoints.default).toEqual({});
    expect(companyImportOperations.fingerprint.notNull).toBe(true);
    expect(companyImportOperations.status.enumValues).toEqual(["pending", "running", "failed", "completed"]);
    expect(config.columns.map((column) => column.name)).not.toContain("error");
    expect(config.foreignKeys).toHaveLength(2);
  });

  it("registers the generated migration and matches its generated snapshot", () => {
    const base = new URL("../migrations/", import.meta.url);
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", base), "utf8"));
    const entry = journal.entries.find((item: { idx: number }) => item.idx === 210);
    const migration = readFileSync(new URL(`${entry.tag}.sql`, base), "utf8");
    expect(migration).toContain('CREATE TABLE "company_import_operations"');
    expect(migration).toContain('("company_id","operation_id")');
    expect(migration).toContain('("organization_id","operation_id")');
    const snapshot = JSON.parse(readFileSync(fileURLToPath(new URL("meta/0210_snapshot.json", base)), "utf8"));
    expect(snapshot.tables["public.company_import_operations"].columns.checkpoints.type).toBe("jsonb");
    expect(snapshot.tables["public.company_import_operations"].indexes.company_import_operations_org_operation_uq.isUnique).toBe(true);
  });
});
