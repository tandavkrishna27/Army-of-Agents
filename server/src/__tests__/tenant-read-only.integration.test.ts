// MIG-005/006/007 Lane B (design D5a) — PostgreSQL, not a test, enforces that the
// shadow admissibility probe cannot write.
//
// The design's first draft asserted effect-freeness by snapshotting a few tables' row
// counts across a probe. That cannot see a write to a table not on the list, and the
// list is hand-maintained — the same "a check that nothing runs" shape this programme
// keeps paying for. `runInTenantReadOnly` opens the tenant transaction in PostgreSQL's
// read-only mode, so ANY write inside it raises 25006 (read_only_sql_transaction)
// whether or not a test thought to look for it.
//
// Gate: Linux CI automatically; Windows-runnable in place via AOA_RUN_WIN_INTEGRATION=1.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { runInTenant, runInTenantReadOnly } from "../db/tenant-context.js";
import { ORG, setupJobControlFixture, type JobControlFixture } from "./helpers/job-control-fixture.js";

/**
 * Drizzle wraps the driver error, so the SQLSTATE lives on `cause`. Asserting the CODE
 * rather than the message keeps this stable across PostgreSQL wordings.
 */
async function expectReadOnlyRefusal(run: () => Promise<unknown>): Promise<void> {
  let raised: unknown;
  try {
    await run();
  } catch (error) {
    raised = error;
  }
  expect(raised, "a write inside a read-only transaction must be refused").toBeDefined();
  const code =
    (raised as { code?: string })?.code ??
    ((raised as { cause?: { code?: string } })?.cause)?.code;
  expect(code).toBe("25006");
}

const RUN_INTEGRATION = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";

describe.skipIf(!RUN_INTEGRATION)("D5a — the probe's transaction is read-only in PostgreSQL", () => {
  let fixture: JobControlFixture;
  let setupError: unknown;

  beforeAll(async () => {
    try {
      fixture = await setupJobControlFixture("tenant-read-only");
    } catch (error) {
      setupError = error;
    }
  }, 240_000);

  afterAll(async () => {
    await fixture?.teardown();
  }, 120_000);

  it("boots the fixture (fail closed)", () => {
    if (setupError) throw setupError;
    expect(fixture).toBeDefined();
  });

  it("reads succeed inside a read-only tenant transaction", async () => {
    const rows = await runInTenantReadOnly(fixture.app.db, ORG, async (_repos, tx) => {
      const result = await tx.execute(sql`select current_setting('aoa.organization_id', true) as org`);
      return result as unknown as Array<{ org: string }>;
    });
    // The tenant GUC must still be set — a read-only transaction that lost its tenant
    // context would read zero rows everywhere and look like a clean "no divergence".
    expect(rows[0]?.org).toBe(ORG);
  });

  it("ANY write inside it raises 25006, without the test naming a table", async () => {
    await expectReadOnlyRefusal(() =>
      runInTenantReadOnly(fixture.app.db, ORG, async (_repos, tx) => {
        await tx.execute(
          sql`INSERT INTO organizations (id, name, slug) VALUES ('a6000000-0000-4000-8000-0000000000ff', 'x', 'x-ro')`,
        );
      }),
    );
  });

  it("a second, unrelated write is refused by the same mechanism", async () => {
    // The point of D5a: the guarantee is not a list of tables somebody remembered.
    await expectReadOnlyRefusal(() =>
      runInTenantReadOnly(fixture.app.db, ORG, async (_repos, tx) => {
        await tx.execute(sql`UPDATE execution_targets SET status = 'disabled'`);
      }),
    );
  });

  it("the read-write sibling still writes — the flag is real, not decorative", async () => {
    // Guards against `runInTenantReadOnly` being a copy of `runInTenant` in disguise,
    // and against a mutant that makes BOTH read-only (which would pass every assertion
    // above while breaking every real caller).
    await runInTenant(fixture.app.db, ORG, async (_repos, tx) => {
      await tx.execute(sql`UPDATE execution_targets SET status = 'active'`);
    });
    const after = (await fixture.admin`SELECT status FROM execution_targets`) as Array<{
      status: string;
    }>;
    expect(after[0]?.status).toBe("active");
  });

  it("rejects a blank Organization before opening a transaction, exactly as runInTenant does", async () => {
    // Parity with the read-write sibling: set_config('aoa.organization_id','') makes a
    // later ''::uuid cast throw, so a blank Organization must fail closed up front.
    await expect(runInTenantReadOnly(fixture.app.db, "  ", async () => 1)).rejects.toThrow(
      /non-empty organizationId/,
    );
  });

  it("read-only does not leak to the next transaction on the same pooled connection", async () => {
    await runInTenantReadOnly(fixture.app.db, ORG, async (_repos, tx) => {
      await tx.execute(sql`select 1`);
    });
    // `SET TRANSACTION` is transaction-scoped, but proving it beats assuming it: a
    // leaked read-only flag would silently disable a live write path.
    await runInTenant(fixture.app.db, ORG, async (_repos, tx) => {
      await tx.execute(sql`UPDATE execution_targets SET status = 'active'`);
    });
  });
});
