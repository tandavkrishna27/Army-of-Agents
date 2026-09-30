// -----------------------------------------------------------------------------
// SVC-001 — desired-state service schema. Clauses (a) and (b, storage half).
//
// This file lives in `server` rather than `packages/db` for a reason worth stating:
// `packages/db` does NOT depend on @armyofagents/worker-protocol (its dependencies are
// shared, drizzle-orm, postgres), so it cannot import the frozen enums. `server`
// depends on both. Reconciling a DB CHECK against the frozen authority is only
// possible here — and hand-listing the values instead would defeat the entire point,
// because the drift these tests exist to catch is exactly a hand-listed copy going
// stale. There are already THREE such copies in this codebase.
//
// What each clause is really proving:
//   (a) immutability is enforced by GRANT OMISSION, not by a trigger. Verified:
//       zero CREATE TRIGGER / CREATE RULE across all 264 migrations. So the ACL is
//       the mechanism, and the tests below exercise it as the non-owner `aoa_app`
//       role — as the real job-control surface does, since app.ts refuses owner
//       fallback by name.
//   (b) storage half only. The memory/context half is deferred to SVC-003 by name;
//       see SVC-001-design.md §4. No policy-reference column is shipped here,
//       because nothing would read it.
// -----------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  SERVICE_DESIRED_STATES,
  SERVICE_INSTANCE_STATUSES,
} from "@armyofagents/worker-protocol";

import { setupJobControlFixture, type JobControlFixture, ORG, COMPANY } from "./helpers/job-control-fixture.js";
import { runInTenant } from "../db/tenant-context.js";

let fixture: JobControlFixture | null = null;
let setupError: unknown = null;

const SERVICE = "a6000000-0000-4000-8000-0000000000a1";

/** Postgres error codes arrive wrapped; unwrap the cause chain. */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function f(): JobControlFixture {
  if (setupError) throw new Error(`fixture setup failed: ${String(setupError)}`);
  if (!fixture) throw new Error("fixture was not initialized");
  return fixture;
}

/** Pull the literal values out of a CHECK constraint definition. */
function checkValues(definition: string): string[] {
  return [...definition.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
}

beforeAll(async () => {
  try {
    fixture = await setupJobControlFixture("svc-001-schema");
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await fixture?.teardown(); } catch { /* ignore */ }
}, 60_000);

const suite = describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1");

suite("SVC-001 (schema) — the CHECK constraints are reconciled against the FROZEN authority", () => {
  it("services.desired_state admits every frozen desired state, including `paused`", async () => {
    // RED STATE: the constraint today is IN ('running','stopped','deleted') — it omits
    // `paused`, so SVC-005's pause/resume has nowhere to store its result.
    const [row] = await f().admin<{ definition: string }[]>`
      SELECT pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'services' AND con.conname = 'services_desired_state_check'
    `;
    expect(row, "services_desired_state_check is missing entirely").toBeTruthy();
    expect(checkValues(row.definition)).toEqual([...SERVICE_DESIRED_STATES].sort());
  });

  it("service_instances.status admits exactly the frozen nine, and nothing else", async () => {
    // RED STATE: today it has five values and includes `interrupted`, which is not a
    // frozen state at all. Asserting set EQUALITY (not superset) is deliberate: an
    // extra value is drift in the same way a missing one is.
    const [row] = await f().admin<{ definition: string }[]>`
      SELECT pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'service_instances' AND con.conname = 'service_instances_status_check'
    `;
    expect(row, "service_instances_status_check is missing entirely").toBeTruthy();
    expect(checkValues(row.definition)).toEqual([...SERVICE_INSTANCE_STATUSES].sort());
  });

  it("`paused` is actually WRITABLE, not merely permitted by a constraint definition", async () => {
    // Reading the constraint text is not the same as proving a write lands. This is the
    // clause SVC-005 depends on, so it gets an end-to-end write rather than a regex.
    const client = f().admin;
    await client`INSERT INTO services (id, organization_id, company_id, desired_state)
      VALUES (${SERVICE}, ${ORG}, ${COMPANY}, 'running')
      ON CONFLICT (id) DO UPDATE SET desired_state = 'running'`;
    await client`UPDATE services SET desired_state = 'paused' WHERE id = ${SERVICE}`;
    const [row] = await client<{ desired_state: string }[]>`
      SELECT desired_state FROM services WHERE id = ${SERVICE}`;
    expect(row.desired_state).toBe("paused");
  });

  it("service_instances can be an FK target — it has unique(organization_id, id)", async () => {
    // RED STATE: service_instances has NO unique constraint at all today, so nothing can
    // bind a composite tenant FK to an instance. Every child table SVC-002/003 needs is
    // blocked on this one line.
    const rows = await f().admin<{ definition: string }[]>`
      SELECT pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'service_instances' AND con.contype = 'u'
    `;
    expect(rows.map((r) => r.definition.replace(/\s+/g, " "))).toContainEqual(
      expect.stringMatching(/UNIQUE \(organization_id, id\)/),
    );
  });
});

suite("SVC-001 (generation) — a generation row is immutable by GRANT OMISSION", () => {
  const GEN_A = "a6000000-0000-4000-8000-0000000000b1";

  it("aoa_app may INSERT a generation", async () => {
    await f().admin`INSERT INTO services (id, organization_id, company_id, desired_state)
      VALUES (${SERVICE}, ${ORG}, ${COMPANY}, 'running')
      ON CONFLICT (id) DO NOTHING`;
    // runInTenant, not a bare execute(): set_config(..., true) is TRANSACTION-local, so
    // a separate statement loses the GUC and RLS rejects the write. This is also the real
    // production path, which makes the test worth more than a hand-rolled equivalent.
    await expect(
      runInTenant(f().app.db, ORG, (_repos, tx) =>
        tx.execute(sql`INSERT INTO service_generations
          (id, organization_id, company_id, service_id, generation, definition)
          VALUES (${GEN_A}::uuid, ${ORG}::uuid, ${COMPANY}::uuid, ${SERVICE}::uuid, 1, '{}'::jsonb)`),
      ),
    ).resolves.toBeDefined();
  });

  it("aoa_app may NOT UPDATE a generation — 42501 insufficient_privilege", async () => {
    await expect(
      runInTenant(f().app.db, ORG, (_repos, tx) => tx.execute(sql`UPDATE service_generations SET definition = '{"x":1}'::jsonb WHERE id = ${GEN_A}::uuid`)),
    ).rejects.toSatisfy((e: unknown) => errorCode(e) === "42501");
  });

  it("aoa_app may NOT DELETE a generation — 42501 insufficient_privilege", async () => {
    await expect(
      runInTenant(f().app.db, ORG, (_repos, tx) => tx.execute(sql`DELETE FROM service_generations WHERE id = ${GEN_A}::uuid`)),
    ).rejects.toSatisfy((e: unknown) => errorCode(e) === "42501");
  });

  it("★ deleting the PARENT service cannot erase generations either — 23001, rows survive", async () => {
    // THE CORRECTION THAT MATTERS. The majority design cascaded generations from
    // `services`. aoa_app holds DELETE on `services`, and a referential action executes
    // with the CONSTRAINT's rights, not the caller's — so a cascade would erase every
    // "immutable" row while aoa_app holds no DELETE on the table, and the three tests
    // above would still pass. They cannot see it. This one can.
    //
    // MUTATION SIGNATURE: flip the FK to ON DELETE CASCADE and this test goes red while
    // every other test in this file stays green.
    await expect(
      runInTenant(f().app.db, ORG, (_repos, tx) => tx.execute(sql`DELETE FROM services WHERE id = ${SERVICE}::uuid`)),
    // 23001 restrict_violation, NOT 23503 foreign_key_violation. The distinction is worth
    // asserting rather than loosening: PostgreSQL raises 23001 only for an ON DELETE
    // RESTRICT action, while NO ACTION raises 23503 at constraint-check time. Pinning
    // 23001 therefore proves the FK is genuinely RESTRICT, which is the property clause
    // (a) depends on — a weaker 23503 assertion would also pass under NO ACTION.
    ).rejects.toSatisfy((e: unknown) => errorCode(e) === "23001");

    const rows = await f().admin<{ id: string }[]>`
      SELECT id FROM service_generations WHERE id = ${GEN_A}`;
    expect(rows, "the generation row was erased by a parent delete").toHaveLength(1);
  });
});

suite("SVC-001 (tenancy) — a generation cannot pair one company with another's service", () => {
  it("binds the TRIPLE composite (organization_id, company_id, service_id)", async () => {
    // Company scoping is NECESSARILY app-layer: `aoa.organization_id` is the only GUC.
    // That makes the denormalized company_id the sole company predicate any later reader
    // has, so its integrity is the whole guarantee. Two independent FKs would let a
    // generation carry company B while its service belongs to company A, both inside
    // org X, with every constraint satisfied.
    const rows = await f().admin<{ definition: string }[]>`
      SELECT pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'service_generations' AND con.contype = 'f'
    `;
    const definitions = rows.map((r) => r.definition.replace(/\s+/g, " "));
    expect(definitions).toContainEqual(
      expect.stringMatching(
        /FOREIGN KEY \(organization_id, company_id, service_id\) REFERENCES (public\.)?services\(organization_id, company_id, id\)/,
      ),
    );
    // And it must NOT cascade — see the parent-delete test above.
    expect(definitions.join(" ")).not.toMatch(/services\(organization_id, company_id, id\) ON DELETE CASCADE/i);
  });

  it("services carries the triple-composite unique the FK above requires", async () => {
    const rows = await f().admin<{ definition: string }[]>`
      SELECT pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'services' AND con.contype = 'u'
    `;
    expect(rows.map((r) => r.definition.replace(/\s+/g, " "))).toContainEqual(
      expect.stringMatching(/UNIQUE \(organization_id, company_id, id\)/),
    );
  });
});
