import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { companies } from "../schema/companies.js";

const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));
const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; tag: string }>;
};

describe("company execution setup state", () => {
  it("requires pending or ready and defaults new Drizzle inserts to pending", () => {
    expect(companies.agentExecutionSetupState.enumValues).toEqual(["pending", "ready"]);
    expect(companies.agentExecutionSetupState.notNull).toBe(true);
    expect(companies.agentExecutionSetupState.default).toBe("pending");
  });

  it("generates a legacy-ready upgrade followed by the pending default for new rows", () => {
    const first = journal.entries.find((entry) => entry.idx === 208);
    const second = journal.entries.find((entry) => entry.idx === 209);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const firstSql = readFileSync(join(migrationsDir, `${first!.tag}.sql`), "utf8");
    const secondSql = readFileSync(join(migrationsDir, `${second!.tag}.sql`), "utf8");
    expect(firstSql).toContain('ADD COLUMN IF NOT EXISTS "agent_execution_setup_state"');
    expect(firstSql).toContain("DEFAULT 'ready'");
    expect(firstSql).toContain("duplicate_object");
    expect(secondSql).toContain('ALTER COLUMN "agent_execution_setup_state" SET DEFAULT \'pending\'');
  });
});
