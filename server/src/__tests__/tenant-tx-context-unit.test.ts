// Windows-visible (cross-platform) unit coverage for the TEN-003 mandatory
// Organization context `runInTenant`. The DB-enforcement proof (forced RLS, pooled
// no-leak, nested inheritance) lives in tenant-tx-context.integration.test.ts
// (embedded-postgres, E2-D05 env-hatch). This unit sibling pins the wrapper's pure
// contract WITHOUT a database:
//   1. `fn` receives the TenantRepositories object (NOT a raw tx / pool handle).
//   2. `runInTenant` returns `fn`'s DATA result (the tx/repos never escape).
//   3. an empty / blank organizationId is rejected BEFORE any DB round-trip
//      (fail closed — never `set_config('aoa.organization_id', '')`, which would make
//      a later `''::uuid` cast throw).
//
// RED (before server/src/db/tenant-context.ts exists): the import throws (module
// missing). GREEN (after): the assertions below hold against a stub pool.
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { runInTenant } from "../db/tenant-context.js";

// A stub `appDb` whose `.transaction(cb)` invokes `cb` with a fake tx. The fake tx
// only needs `.execute` (withTenantTx issues the transaction-local set_config first)
// — tenantRepositories builds its accessor object lazily and only touches `tx` when
// a repo method is actually invoked, so no real query builder is required here.
function makeStubDb() {
  const executed: SQL[] = [];
  const tx = {
    execute: vi.fn(async (query: SQL) => {
      executed.push(query);
      return { rows: [] };
    }),
    // present so an accidental raw-tx leak is observable if a repo method were run
    __isFakeTx: true,
  };
  const transaction = vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  const appDb = { transaction } as never;
  return { appDb, tx, transaction, executed };
}

const ORG = "11111111-1111-1111-1111-111111111111";

describe("runInTenant (TEN-003) — wrapper contract (pure)", () => {
  it("passes the TenantRepositories object (not a raw tx) to fn", async () => {
    const { appDb, tx } = makeStubDb();
    let received: unknown = null;
    await runInTenant(appDb, ORG, async (repos) => {
      received = repos;
      return 0;
    });
    // fn got the repositories, NOT the transaction handle.
    expect(received).not.toBe(tx);
    expect((received as { __isFakeTx?: boolean }).__isFakeTx).toBeUndefined();
    // It is the tenant-kernel repository object (TEN-001a/b accessor groups).
    expect(Object.keys(received as object).sort()).toEqual([
      "attempts",
      "jobArtifacts",
      "jobSecretHandles",
      "jobs",
      "leases",
      "serviceInstances",
      "services",
      "workers",
    ]);
    expect(Object.prototype.propertyIsEnumerable.call(received, "jobControl")).toBe(false);
    expect(typeof (received as { jobControl: { admission?: unknown } }).jobControl.admission).toBe("function");
    const repositoryGroups = received as Record<string, {
      insert?: unknown;
      getById?: unknown;
      listForOrganization?: unknown;
    }>;
    const workersRepository = repositoryGroups.workers!;
    expect(Object.keys(workersRepository).sort()).toEqual(["getById", "listForOrganization"]);
    expect(workersRepository.insert).toBeUndefined();
    expect(typeof workersRepository.getById).toBe("function");
    expect(typeof workersRepository.listForOrganization).toBe("function");
    for (const [name, group] of Object.entries(repositoryGroups)) {
      if (name === "workers") continue;
      expect(typeof group.insert).toBe("function");
      expect(typeof group.getById).toBe("function");
    }
  });

  it("returns fn's DATA result (the tx/repos do not escape the callback)", async () => {
    const { appDb } = makeStubDb();
    const result = await runInTenant(appDb, ORG, async () => ({ ok: true, n: 7 }));
    expect(result).toEqual({ ok: true, n: 7 });
  });

  it("delegates to withTenantTx: opens a transaction and binds the org id as a param in the transaction-local set_config", async () => {
    const { appDb, transaction, executed } = makeStubDb();
    await runInTenant(appDb, ORG, async () => "done");
    expect(transaction).toHaveBeenCalledTimes(1); // exactly one transaction opened
    expect(executed).toHaveLength(1); // exactly the set_config, before fn
    const { sql: text, params } = new PgDialect().sqlToQuery(executed[0]!);
    expect(text).toContain("set_config('aoa.organization_id',");
    expect(text).toMatch(/,\s*true\)/); // transaction-local (is_local => true)
    expect(params).toEqual([ORG]); // org bound as a parameter...
    expect(text).not.toContain(ORG); // ...never string-interpolated (injection-safe)
  });

  it("rejects an empty organizationId BEFORE opening any transaction (fail closed)", async () => {
    const { appDb, transaction } = makeStubDb();
    await expect(runInTenant(appDb, "", async () => "x")).rejects.toThrow(
      /non-empty organizationId/i,
    );
    expect(transaction).not.toHaveBeenCalled(); // never reached the DB
  });

  it("rejects a blank/whitespace organizationId BEFORE opening any transaction (fail closed)", async () => {
    const { appDb, transaction } = makeStubDb();
    for (const bad of ["   ", "\t", "\n"]) {
      await expect(runInTenant(appDb, bad, async () => "x")).rejects.toThrow(
        /non-empty organizationId/i,
      );
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not invoke fn when the organizationId is rejected", async () => {
    const { appDb } = makeStubDb();
    const fn = vi.fn(async () => "x");
    await expect(runInTenant(appDb, "  ", fn)).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});
