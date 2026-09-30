import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { executionTargets } from "../schema/execution_targets.js";

describe("execution_targets schema", () => {
  it("is tenant-scoped with a nullable organization_id FK and required slug/kind", () => {
    const cfg = getTableConfig(executionTargets);
    expect(cfg.name).toBe("execution_targets");
    const col = (n: string) => cfg.columns.find((c) => c.name === n)!;
    expect(col("organization_id").notNull).toBe(false); // nullable = system/shared rows
    expect(col("owner_user_id").notNull).toBe(false);
    expect(col("slug").notNull).toBe(true);
    expect(col("kind").notNull).toBe(true);
    expect(col("trust_class").notNull).toBe(true);
    expect(col("status").notNull).toBe(true);
    expect(col("last_seen_at").notNull).toBe(false);
  });
  it("has an (organization_id, slug) unique constraint with NULLS NOT DISTINCT (idempotent system seed)", () => {
    const cfg = getTableConfig(executionTargets);
    const uq = cfg.uniqueConstraints.find((c) => c.name === "execution_targets_org_slug_uq")!;
    expect(uq.columns.map((c) => (c as { name: string }).name)).toEqual(["organization_id", "slug"]);
    // NULLS NOT DISTINCT lets (NULL, "control-plane") collide so the boot seed is idempotent.
    expect((uq as { nullsNotDistinct?: boolean }).nullsNotDistinct).toBe(true);
  });
  it("carries a nullable worker_token_hash (hashed rotatable worker credential — never the row id)", () => {
    const cfg = getTableConfig(executionTargets);
    const col = cfg.columns.find((c) => c.name === "worker_token_hash");
    expect(col).toBeTruthy();
    expect(col!.notNull).toBe(false); // system/seeded rows have no token
  });
});
