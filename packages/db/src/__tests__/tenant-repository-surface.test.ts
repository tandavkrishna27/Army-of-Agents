// packages/db/src/__tests__/tenant-repository-surface.test.ts
//
// Compile/export-surface guard for the tenant repository boundary (TEN-001a).
//
// The tenant repository is the ONLY sanctioned reader of the new-path tables, and
// it is bound to a caller-supplied tenant transaction handle (`tx`). The package
// public surface must therefore expose EXACTLY `tenantRepositories` (a factory)
// and nothing else at runtime — no raw unscoped cross-tenant reader (e.g.
// `getAllJobs(db)`) that could sidestep the TEN-003 `runInTenant` context and
// forced RLS. TypeScript types (`TenantRepositories`, insert/select aliases)
// erase at runtime, so a correct module has exactly one own enumerable key.
//
// Plain unit test (no DB) — Windows-visible, always runs.
//
// RED (before repositories/tenant/index.ts exists): the import throws
// (module missing). GREEN (after): exactly one runtime export, a function.
import { describe, expect, it } from "vitest";
import * as tenantRepoModule from "../repositories/tenant/index.js";
import type { Db } from "../client.js";

describe("tenant repository public surface (TEN-001a)", () => {
  it("exports exactly tenantRepositories and no raw unscoped reader", () => {
    expect(Object.keys(tenantRepoModule).sort()).toEqual(["tenantRepositories"]);
  });

  it("tenantRepositories is a factory function", () => {
    expect(typeof tenantRepoModule.tenantRepositories).toBe("function");
  });

  // TEN-001b extends the factory with the worker/service/artifact/secret-handle
  // accessors. The factory builds its repo object lazily (each method only
  // touches `tx` when invoked), so a trivial stub tx exercises the shape without
  // a DB. Guards against a missing accessor group at runtime (the interface
  // guards it at compile time).
  it("factory returns every tenant-kernel accessor group (TEN-001a + TEN-001b)", () => {
    const repos = tenantRepoModule.tenantRepositories({} as unknown as Db);
    expect(Object.keys(repos).sort()).toEqual([
      "attempts",
      "jobArtifacts",
      "jobSecretHandles",
      "jobs",
      "leases",
      "serviceInstances",
      "services",
      "workers",
    ]);
    expect(Object.prototype.propertyIsEnumerable.call(repos, "jobControl")).toBe(false);
    expect(typeof repos.jobControl.admission).toBe("function");
    expect(typeof repos.jobControl.insertJobOnce).toBe("function");
    // Every accessor group exposes getById. Every group EXCEPT `workers` also
    // exposes insert: workers are created ONLY through the device-bound
    // enrollment path (WorkerEnrollmentRepository), never a plain tenant insert,
    // so WorkersRepository deliberately omits `insert`. Asserting insert on
    // workers would demand a method whose existence would itself weaken that
    // enrollment-only boundary, so it is the one documented exemption.
    for (const [name, group] of Object.entries(repos)) {
      expect(typeof (group as { getById: unknown }).getById).toBe("function");
      if (name !== "workers") {
        expect(typeof (group as { insert: unknown }).insert).toBe("function");
      }
    }
  });
});
