// MIG-010 Unit 2.4a Task 3 — `environment_leases.created_at` comes from the DATABASE clock.
//
// ★ WHY THIS FILE EXISTS. Design §11.4: *nothing today would red if `acquireLease` reverted
// to the application clock.* Removing the app-clock stamp is a one-line change protected by
// zero tests, and the whole watermark is unsound without it: Unit 2.4b narrows the canary
// gate's lease inventory with `created_at <= <a DB-clock snapshot instant>`, so an app-clock
// `created_at` makes that a CROSS-CLOCK comparison and any host/database skew decides whether
// a lease is inside or outside the watermark. That is the two-clock bug §3.3 exists to close,
// reintroduced at the other end.
//
// ★ HOW IT DISCRIMINATES. Asserting "created_at is roughly now" proves nothing — both clocks
// say roughly now on a healthy box, which is exactly why the revert is invisible. So the test
// SKEWS the application clock to a wildly wrong instant (2000-01-01) with Date-only fake
// timers, and then reads the two columns apart:
//
//     acquired_at  -- deliberately still the APPLICATION clock -> the year 2000
//     created_at   -- the column DEFAULT now()                 -> the real database clock
//
// Re-add `createdAt: now` to `acquireLease` and `created_at` collapses onto `acquired_at`,
// which is what the assertions below refuse.
//
// Windows-skipped unless AOA_RUN_WIN_INTEGRATION=1 (Issue #114); Linux CI is the authority.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createDb, type Db } from "@armyofagents/db";
import { environmentService } from "../services/environments.js";
import { startMigratedDatabase } from "./helpers/migrated-database.js";

const RUN = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";

const ORG = "c1000000-0000-4000-8000-000000000001";
const COMPANY = "c1000000-0000-4000-8000-000000000002";
const ENV = "c1000000-0000-4000-8000-000000000003";

/** Far enough from any real database clock that no skew could explain it. */
const SKEWED_APP_CLOCK = new Date("2000-01-01T00:00:00.000Z");

type Fixture = { admin: Sql; ownerDb: Db; teardown: () => Promise<void> };
let fixture: Fixture | null = null;

describe.skipIf(!RUN)("MIG-010 Unit 2.4 — lease created_at is database-clock", () => {
  beforeAll(async () => {
    const database = await startMigratedDatabase({ label: "aoa-mig-010-clock-" });
    const { admin, adminUrl, teardown } = database;
    try {
      await admin`INSERT INTO organizations (id, name, slug)
        VALUES (${ORG}, 'clock org', 'clock-org')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'clock company', 'CLK')`;
      await admin`INSERT INTO environments (id, company_id, name, driver, status)
        VALUES (${ENV}, ${COMPANY}, 'clock-env', 'sandbox', 'active')`;
      fixture = { admin, ownerDb: createDb(adminUrl), teardown };
    } catch (error) {
      await teardown();
      throw error;
    }
  }, 180_000);

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await fixture?.teardown();
    fixture = null;
  }, 60_000);

  it("stamps created_at from the DATABASE even when the application clock is 26 years wrong", async () => {
    const { admin, ownerDb } = fixture!;
    // Date ONLY. Faking timers wholesale would stall postgres.js's own timeouts.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SKEWED_APP_CLOCK);
    expect(new Date().toISOString()).toBe(SKEWED_APP_CLOCK.toISOString());

    const lease = await environmentService(ownerDb).acquireLease({
      companyId: COMPANY,
      environmentId: ENV,
      provider: "e2b",
      providerLeaseId: "sbx-clock",
    });

    vi.useRealTimers();
    const rows = await admin<
      { created_at: Date; acquired_at: Date; db_now: Date }[]
    >`SELECT created_at, acquired_at, now() AS db_now
      FROM environment_leases WHERE id = ${lease.id}`;
    const row = rows[0]!;

    // (a) The application clock DID reach the row — so the fake is real and the test is not
    // vacuous. `acquired_at` is deliberately left on the app clock (it takes no part in the
    // watermark), and here it is, in the year 2000.
    expect(row.acquired_at.toISOString()).toBe(SKEWED_APP_CLOCK.toISOString());

    // (b) …and `created_at` did NOT follow it. This is the assertion that reds the moment
    // `createdAt: now` comes back to `acquireLease`.
    expect(row.created_at.toISOString()).not.toBe(SKEWED_APP_CLOCK.toISOString());
    expect(row.created_at.getTime()).toBeGreaterThan(SKEWED_APP_CLOCK.getTime());

    // (c) And it is the DATABASE's clock specifically: within a second of a `now()` read taken
    // in the same statement, on the same server.
    expect(Math.abs(row.created_at.getTime() - row.db_now.getTime())).toBeLessThan(1_000);
  });

  it("keeps created_at monotonic against a DB-clock watermark read after it", async () => {
    // The shape Unit 2.4b's narrowing actually performs: a lease acquired BEFORE the pass
    // reads its snapshot instant must satisfy `created_at <= watermark`, so it stays IN the
    // inventory and the gate demands a crosswalk record for it. With an app-clock stamp on a
    // host running fast, this is the comparison that would silently drop the lease OUT of
    // scope — a lease the gate then never asks about.
    const { admin, ownerDb } = fixture!;
    const lease = await environmentService(ownerDb).acquireLease({
      companyId: COMPANY,
      environmentId: ENV,
      provider: "e2b",
      providerLeaseId: "sbx-clock-2",
    });
    const rows = await admin<{ in_scope: boolean }[]>`
      SELECT (l.created_at <= (SELECT now())) AS in_scope
      FROM environment_leases l WHERE l.id = ${lease.id}`;
    expect(rows[0]!.in_scope).toBe(true);
  });
});
