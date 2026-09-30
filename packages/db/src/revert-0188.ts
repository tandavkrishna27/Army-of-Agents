// REVERSIBILITY ESCAPE HATCH — manual, single-org only. NOT a journaled
// migration (would auto-apply and undo Phase 1). Run: tsx src/revert-0188.ts
// Refuses unless exactly ONE Organization exists.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

// Read the 0188 migration file EXACTLY the way the migrator does
// (client.ts readMigrationFileContent — no line-ending normalization) so the
// sha256 matches the journal row the migrator inserted. The
// drizzle.__drizzle_migrations table is keyed by `hash`, NOT `name` (it has no
// `name` column — see client.ts), so this is how we locate the 0188 row.
async function compute0188JournalHash(): Promise<string> {
  const content = await readFile(
    new URL("./migrations/0188_organizations.sql", import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

// Compute the sha256 of EVERY migration file ordered AFTER 0188_organizations in
// the journal (idx > 188: 0189…0196 today, plus any future phase), read/hashed
// the same way compute0188JournalHash does — these are the exact hashes the
// migrator recorded for the later phases. revert0188 only undoes 0188's own
// schema; the later phases add org-referencing FKs/indexes that the dynamic FK
// sweep below DROPS but this script never restores. Because AoA's migrator is
// hash-set-membership (client.ts re-applies any file whose hash is absent),
// deleting only the 0188 row while 0189+ stay applied would let a forward
// redeploy re-run 0188 ALONE — restoring the base org tables but never the
// dependent FKs/indexes those later phases owned — leaving a permanently
// inconsistent schema. The in-transaction guard below uses these hashes to
// refuse in that state. A full 0196->0188 reverse is out of scope.
async function computeLaterMigrationHashes(): Promise<string[]> {
  const journalRaw = await readFile(
    new URL("./migrations/meta/_journal.json", import.meta.url),
    "utf8",
  );
  const journal = JSON.parse(journalRaw) as {
    entries?: Array<{ idx?: number; tag?: string }>;
  };
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const base = entries.find((entry) => entry.tag === "0188_organizations");
  if (!base || typeof base.idx !== "number") {
    throw new Error(
      "revert-0188: could not locate 0188_organizations in the migration journal",
    );
  }
  const baseIdx = base.idx;
  const laterTags = entries
    .filter(
      (entry): entry is { idx: number; tag: string } =>
        typeof entry.idx === "number" &&
        entry.idx > baseIdx &&
        typeof entry.tag === "string",
    )
    .map((entry) => entry.tag);
  return Promise.all(
    laterTags.map(async (tag) => {
      const content = await readFile(
        new URL(`./migrations/${tag}.sql`, import.meta.url),
        "utf8",
      );
      return createHash("sha256").update(content).digest("hex");
    }),
  );
}

// Same refusal used by BOTH the cheap pre-check and the authoritative
// in-transaction recheck, so callers (and the guard test) see one stable
// message regardless of which gate fires.
function singleOrgRefusal(count: number): Error {
  return new Error(
    `revert-0188 refused: expected exactly 1 organization, found ${count}. ` +
      `Once a second tenant exists this is a one-way door — restore the pre-0188 snapshot instead.`,
  );
}

// A sibling to singleOrgRefusal for the OTHER one-way-door condition: even with a
// single org, refuse once any migration ordered after 0188 is still applied.
// Reverting then would delete only the 0188 journal row while 0189+ stay applied,
// so a forward redeploy re-runs 0188 alone and never restores the FKs/indexes the
// later phases added (which the FK sweep here drops) — a permanently inconsistent
// schema. Restore the pre-0188 snapshot instead. See computeLaterMigrationHashes.
function laterMigrationsRefusal(): Error {
  return new Error(
    "revert-0188 refused: migrations after 0188 are applied — restore the pre-0188 snapshot instead",
  );
}

export async function revert0188(sql: Sql): Promise<void> {
  // Cheap fast-fail (no lock): give a friendly early error when a second tenant
  // already exists, without paying for a table lock. This is NOT the real gate —
  // it is racy on its own (a concurrent org could commit between here and the
  // drops below). The authoritative gate is the post-lock recheck inside the
  // transaction.
  const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM organizations`;
  if (count !== 1) throw singleOrgRefusal(count);
  const journalHash = await compute0188JournalHash();
  // Hashes of every migration ordered after 0188 (file I/O only — no DB). The
  // later-migration guard below runs the actual membership check INSIDE the
  // transaction (after the authoritative single-org recheck) so the single-org
  // refusal still fires first for the 2-org and TOCTOU-race paths.
  const laterHashes = await computeLaterMigrationHashes();
  await sql.begin(async (tx) => {
    // 0. Pin READ COMMITTED as the VERY FIRST statement (before the LOCK below).
    //    The post-lock recheck's correctness depends on READ COMMITTED: each
    //    statement takes a fresh snapshot, so the SELECT after the lock sees a
    //    2nd org that committed while A was waiting for the lock. Under REPEATABLE
    //    READ the recheck would read the transaction's original pre-lock snapshot
    //    (taken before that commit) and be defeated → both tenants dropped. The
    //    server default is READ COMMITTED, so this is behaviourally a no-op today;
    //    pinning it makes the guarantee explicit and immune to a changed default.
    await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
    // 0b. Close the TOCTOU window on the destructive single-org rollback. Take an
    //    ACCESS EXCLUSIVE lock on organizations as the first data statement in the
    //    transaction, THEN re-run the single-org count check. ACCESS EXCLUSIVE
    //    conflicts with the RowExclusive lock a concurrent INSERT holds, so no
    //    org can be created between this recheck and the drops below — a second
    //    tenant committing after the pre-check above can no longer sneak in and
    //    have BOTH tenants' data dropped. This recheck (not the pre-check) is the
    //    authoritative one-way-door guard.
    await tx.unsafe(`LOCK TABLE "organizations" IN ACCESS EXCLUSIVE MODE`);
    const lockedRows = (await tx.unsafe(
      `SELECT count(*)::int AS count FROM organizations`,
    )) as unknown as { count: number }[];
    const lockedCount = lockedRows[0]!.count;
    if (lockedCount !== 1) throw singleOrgRefusal(lockedCount);
    // 0c. Forward-consistency guard. Now that the single-org gate has passed,
    //    refuse if any migration ordered after 0188 is still recorded as applied.
    //    This runs AFTER the single-org recheck (so the 2-org and race paths keep
    //    failing with the single-org message) and BEFORE any destructive
    //    statement, so it is non-destructive: a refused revert leaves the schema
    //    and journal untouched. Placed here (not in the pre-`begin` fast-fail) on
    //    purpose. See laterMigrationsRefusal / computeLaterMigrationHashes.
    if (laterHashes.length > 0) {
      const appliedLater = (await tx.unsafe(
        `SELECT 1 AS one FROM "drizzle"."__drizzle_migrations" WHERE hash = ANY($1::text[]) LIMIT 1`,
        [laterHashes],
      )) as unknown as { one: number }[];
      if (appliedLater.length > 0) throw laterMigrationsRefusal();
    }
    // 1. Drop the tenant FK on companies.
    await tx.unsafe(`ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "companies_organization_id_organizations_id_fk"`);
    await tx.unsafe(`ALTER TABLE "companies" ALTER COLUMN "organization_id" DROP DEFAULT`);
    // 2. Restore global uniqueness (safe: single org => prefixes/identifiers are already globally unique).
    await tx.unsafe(`DROP INDEX IF EXISTS "companies_org_issue_prefix_idx"`);
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "companies_issue_prefix_idx" ON "companies" USING btree ("issue_prefix")`);
    await tx.unsafe(`DROP INDEX IF EXISTS "issues_identifier_idx"`);
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "issues_identifier_idx" ON "issues" USING btree ("identifier")`);
    // 3. Drop the org column + tenant tables.
    await tx.unsafe(`ALTER TABLE "companies" DROP COLUMN IF EXISTS "organization_id"`);
    // Later phases add org FKs from OTHER tables (provider_connections in 0190,
    // execution_targets in 0191, and any future org-referencing table). DROP
    // TABLE below has no CASCADE, so those inbound FKs would abort the whole
    // (transactional) revert with a dependent-object error. Dynamically drop
    // EVERY foreign key that references organizations first — robust and
    // future-proof, no hardcoded table list. (organizations still exists here;
    // the single-org guard above guarantees the ::regclass cast resolves.)
    await tx.unsafe(`
      DO $$
      DECLARE
        r record;
      BEGIN
        FOR r IN
          SELECT conrelid::regclass AS tbl, conname
          FROM pg_constraint
          WHERE contype = 'f'
            AND confrelid = 'organizations'::regclass
            AND conrelid <> 'organizations'::regclass
        LOOP
          EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.tbl, r.conname);
        END LOOP;
      END $$;
    `);
    await tx.unsafe(`DROP TABLE IF EXISTS "organization_invitations"`);
    await tx.unsafe(`DROP TABLE IF EXISTS "organization_memberships"`);
    await tx.unsafe(`DROP TABLE IF EXISTS "organizations"`);
    // 4. Manually strip the 0188 journal row from __drizzle_migrations so the
    //    migrator does not think it is still applied. The table has no `name`
    //    column — rows are keyed by the sha256 of the migration file content
    //    (see client.ts), so delete by hash. (Operator must also delete the
    //    0188 files + journal entry from source before re-generating.)
    await tx.unsafe(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`, [journalHash]);
  });
  // eslint-disable-next-line no-console
  console.log("revert-0188 complete: Phase 1 tenant schema removed (single-org state restored).");
}

// Only run the destructive script when executed directly (tsx src/revert-0188.ts),
// never when imported (e.g. by the integration test).
function invokedAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const here = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(here);
  } catch {
    return resolvePath(entry) === resolvePath(here);
  }
}

if (invokedAsScript()) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for revert-0188");
  const sql = postgres(url, { max: 1 });
  try {
    await revert0188(sql);
  } finally {
    await sql.end();
  }
}
