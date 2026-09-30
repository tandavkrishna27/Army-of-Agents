// Windows-visible (cross-platform) unit coverage for the RLS canary building
// blocks: the pure role-name validation used before DDL interpolation, and the
// GUC-arg shaping of withTenantTx (transaction-local set_config, parameterized
// org id). The RLS ENFORCEMENT proof lives in rls-canary.integration.test.ts
// (Linux-only embedded-postgres).
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { isSafeRoleName, assertSafeRoleName } from "../db/rls-bootstrap.js";
import { withTenantTx } from "../db/with-tenant-tx.js";

describe("rls canary — role-name validation (pure)", () => {
  it("accepts valid Postgres identifiers", () => {
    for (const role of ["aoa_app", "AppRole1", "_x", "a", "role_2_x"]) {
      expect(isSafeRoleName(role)).toBe(true);
    }
  });

  it("rejects injection / invalid identifiers", () => {
    for (const role of ["aoa-app", "1abc", "app app", "app;DROP ROLE x", "", "app'", '"app"', "app$", "aoa_app;"]) {
      expect(isSafeRoleName(role)).toBe(false);
    }
  });

  it("assertSafeRoleName returns a safe role and throws on an unsafe one", () => {
    expect(assertSafeRoleName("aoa_app")).toBe("aoa_app");
    expect(() => assertSafeRoleName("aoa-app")).toThrow(/unsafe role/i);
    expect(() => assertSafeRoleName("app; DROP TABLE company_secrets")).toThrow(/unsafe role/i);
  });
});

describe("withTenantTx — GUC-arg shaping (pure)", () => {
  it("sets the tenant GUC transaction-local (is_local=true), binds the org id as a param, then runs fn on the tx", async () => {
    const orgId = "11111111-1111-1111-1111-111111111111";
    const executed: SQL[] = [];
    const tx = {
      execute: vi.fn(async (query: SQL) => {
        executed.push(query);
        return { rows: [] };
      }),
    };
    let receivedTx: unknown = null;
    const db = {
      transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    } as never;

    const result = await withTenantTx(db, orgId, async (t) => {
      receivedTx = t;
      return "ok";
    });

    expect(result).toBe("ok");
    expect(receivedTx).toBe(tx); // fn receives the transaction handle
    expect(tx.execute).toHaveBeenCalledTimes(1); // exactly the set_config, before fn

    const { sql: text, params } = new PgDialect().sqlToQuery(executed[0]);
    expect(text).toContain("set_config('aoa.organization_id',");
    expect(text).toMatch(/,\s*true\)/); // transaction-local flag present
    expect(params).toEqual([orgId]); // org id bound as a parameter...
    expect(text).not.toContain(orgId); // ...never string-interpolated (injection-safe)
  });
});
