// DSK-002 Lane A / I1 + I3 — the SERVICE actually calls the binding.
//
// `folder-grant-binding.test.ts` proves the pure function. This proves the wiring, and it
// exists because of Lane D's lesson: there, two mutants survived precisely because the
// service function had no test of its own, so "return the raw rows" and "drop the filter"
// changed nothing observable. A pure guard nothing calls is not a guard.
//
// The DB is mocked with the repo's shared drizzle stubs; the assertions are about which
// decisions the service makes, not about SQL.

import { describe, expect, it, vi } from "vitest";

import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({ folderGrants: makeTableProxy("folder_grants") }));

/** `runInTenant(db, orgId, cb)` → run `cb` against a tx that returns `rows`. */
const rowsToReturn: { current: unknown[] } = { current: [] };
const tenantCalls: string[] = [];
vi.mock("../db/tenant-context.js", () => ({
  runInTenant: async (_db: unknown, orgId: string, cb: (repos: unknown, tx: unknown) => unknown) => {
    tenantCalls.push(orgId);
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => rowsToReturn.current }) }) }),
    };
    return cb({}, tx);
  },
}));

const { createFolderGrantService } = await import("../services/folder-grant.js");

const ORG = "00000000-0000-4000-8000-000000000000";
const TARGET_A = "11111111-1111-4111-8111-111111111111";
const TARGET_B = "22222222-2222-4222-8222-222222222222";

const GRANT_ROW = {
  folderGrantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerUserId: "user-1",
  executionTargetId: TARGET_A,
  deviceGeneration: 3,
  declaredBasePath: "work/project",
};

const PRESENTED = { ownerUserId: "user-1", executionTargetId: TARGET_A, deviceGeneration: 3 };

const service = () => createFolderGrantService({ appDb: {} as never });

describe("DSK-002 — resolveCapturedPath refuses an unbound device", () => {
  it("admits an in-base path for the bound device", async () => {
    rowsToReturn.current = [GRANT_ROW];
    const result = await service().resolveCapturedPath({
      organizationId: ORG, folderGrantId: GRANT_ROW.folderGrantId,
      capturedPath: "work/project/src/a.ts", presented: PRESENTED,
    });
    expect(result.admitted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("refuses the SAME path when another desktop presents the grant", async () => {
    // Identical grant, identical path — only the presenting device differs. Before the
    // binding this was admitted, because org RLS scope is not a device scope.
    rowsToReturn.current = [GRANT_ROW];
    const result = await service().resolveCapturedPath({
      organizationId: ORG, folderGrantId: GRANT_ROW.folderGrantId,
      capturedPath: "work/project/src/a.ts",
      presented: { ...PRESENTED, executionTargetId: TARGET_B },
    });
    expect(result).toMatchObject({ admitted: false, reason: "wrong_target" });
  });

  it("refuses after the device is re-enrolled", async () => {
    rowsToReturn.current = [GRANT_ROW];
    const result = await service().resolveCapturedPath({
      organizationId: ORG, folderGrantId: GRANT_ROW.folderGrantId,
      capturedPath: "work/project/src/a.ts",
      presented: { ...PRESENTED, deviceGeneration: 4 },
    });
    expect(result).toMatchObject({ admitted: false, reason: "stale_device_generation" });
  });

  it("keeps the out-of-base and secret refusals distinguishable from a binding refusal", async () => {
    rowsToReturn.current = [GRANT_ROW];
    const svc = service();
    await expect(svc.resolveCapturedPath({
      organizationId: ORG, folderGrantId: GRANT_ROW.folderGrantId,
      capturedPath: "elsewhere/a.ts", presented: PRESENTED,
    })).resolves.toMatchObject({ admitted: false, reason: "out_of_base" });

    await expect(svc.resolveCapturedPath({
      organizationId: ORG, folderGrantId: GRANT_ROW.folderGrantId,
      capturedPath: "work/project/.env", presented: PRESENTED,
    })).resolves.toMatchObject({ admitted: false, reason: "likely_secret" });
  });

  it("refuses when no grant row resolves", async () => {
    rowsToReturn.current = [];
    const result = await service().resolveCapturedPath({
      organizationId: ORG, folderGrantId: GRANT_ROW.folderGrantId,
      capturedPath: "work/project/src/a.ts", presented: PRESENTED,
    });
    expect(result).toMatchObject({ admitted: false, grant: null, reason: "grant_absent" });
  });

  it("scopes the read to the caller's organization", async () => {
    rowsToReturn.current = [GRANT_ROW];
    tenantCalls.length = 0;
    await service().resolveCapturedPath({
      organizationId: ORG, folderGrantId: GRANT_ROW.folderGrantId,
      capturedPath: "work/project/src/a.ts", presented: PRESENTED,
    });
    expect(tenantCalls).toEqual([ORG]);
  });
});

describe("DSK-002 — admitCapture refuses the WHOLE capture, not path by path", () => {
  it("admits nothing at all when the binding fails", async () => {
    // The question "may this device use this grant" is prior to "is this path in the
    // base". A binding refusal that degraded into a per-path filter would still stage
    // every in-base path for the wrong device.
    rowsToReturn.current = [GRANT_ROW];
    const result = await service().admitCapture({
      organizationId: ORG, folderGrantId: GRANT_ROW.folderGrantId,
      presented: { ...PRESENTED, executionTargetId: TARGET_B },
      entries: [
        { path: "work/project/src/a.ts", kind: "file" },
        { path: "work/project/src/b.ts", kind: "file" },
      ],
    });
    expect(result.refusal).toBe("wrong_target");
    expect(result.paths.admitted).toEqual([]);
    expect(result.paths.rejected).toEqual([]);
  });

  it("admits the in-base entries for a bound device — non-vacuity", async () => {
    // Without this, the assertion above would pass for a function that always returns
    // an empty admitted set.
    rowsToReturn.current = [GRANT_ROW];
    const result = await service().admitCapture({
      organizationId: ORG, folderGrantId: GRANT_ROW.folderGrantId,
      presented: PRESENTED,
      entries: [
        { path: "work/project/src/a.ts", kind: "file" },
        { path: "elsewhere/b.ts", kind: "file" },
        { path: "work/project/notes", kind: "symlink" },
      ],
    });
    expect(result.refusal).toBeNull();
    expect(result.paths.admitted).toEqual(["work/project/src/a.ts"]);
    expect(result.paths.rejected.map((r) => r.reason).sort())
      .toEqual(["out_of_base", "symlink_unrepresentable"]);
  });
});
