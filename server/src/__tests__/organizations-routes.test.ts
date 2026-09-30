import { describe, it, expect, vi } from "vitest";
import { createSelfServeOrganization } from "../services/organizations.js";

// Sequence-style fake db (see CLAUDE.md Test Patterns).
function fakeDb() {
  const inserts: any[] = [];
  const db: any = {
    insert: (tbl: any) => ({
      values: (v: any) => ({ returning: async () => { inserts.push({ tbl, v }); return [{ id: v.id ?? "org-new", ...v }]; } }),
    }),
    // Fix 5: createSelfServeOrganization now wraps insert + owner-membership in
    // one db.transaction. The fake models a pass-through tx (callback runs on the
    // same fake handle) so the unit test still exercises the happy path. Real
    // rollback is proven in organizations-transaction.integration.test.ts.
    transaction: async (fn: (tx: any) => Promise<any>) => fn(db),
  };
  return { db, inserts };
}

describe("createSelfServeOrganization", () => {
  it("creates the org and makes the caller its owner", async () => {
    const { db, inserts } = fakeDb();
    const ensureOrgOwner = vi.fn(async () => "m1");
    // 3rd arg is now a FACTORY (handle) => { ensureOrgOwner } so the membership
    // write can bind to the transaction handle.
    const { organization: org } = await createSelfServeOrganization(
      db,
      { name: "Acme", ownerUserId: "u1" },
      (() => ({ ensureOrgOwner })) as any,
    );
    expect(org.name).toBe("Acme");
    expect(ensureOrgOwner).toHaveBeenCalledWith(org.id, "u1");
    expect(inserts.some((i) => i.v.name === "Acme")).toBe(true);
  });

  it("records the authenticated actor as createdByUserId on the org insert (Fix A)", async () => {
    const { db, inserts } = fakeDb();
    const ensureOrgOwner = vi.fn(async () => "m1");
    await createSelfServeOrganization(
      db,
      { name: "Acme", ownerUserId: "u1" },
      (() => ({ ensureOrgOwner })) as any,
    );
    const orgInsert = inserts.find((i) => i.v.name === "Acme");
    expect(orgInsert?.v.createdByUserId).toBe("u1");
  });

  it("normalizes at the service seam and rejects invisible names without a write", async () => {
    const normalized = fakeDb();
    const ensureOrgOwner = vi.fn(async () => "m1");
    const { organization: org } = await createSelfServeOrganization(
      normalized.db,
      { name: "  Cafe\u0301  ", ownerUserId: "u1" },
      (() => ({ ensureOrgOwner })) as any,
    );
    expect(org.name).toBe("Caf\u00e9");
    expect(normalized.inserts.some((entry) => entry.v.name === "Caf\u00e9")).toBe(true);

    const rejected = fakeDb();
    await expect(
      createSelfServeOrganization(
        rejected.db,
        { name: "Acme\u202eCorp", ownerUserId: "u1" },
        (() => ({ ensureOrgOwner })) as any,
      ),
    ).rejects.toThrow(/invalid or invisible characters/i);
    expect(rejected.inserts).toHaveLength(0);
  });
});
