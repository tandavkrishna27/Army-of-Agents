---
"@armyofagents/db": patch
---

fix(db): add `IF NOT EXISTS` to every `CREATE TABLE` / `CREATE INDEX` / `CREATE UNIQUE INDEX` in the 9 migration files that pre-dated PR #121's fix on 0080. Prevents the half-applied-migration footgun in `applyPendingMigrationsManually` (`packages/db/src/client.ts:222`) where a partially-applied migration with one new + one existing object would permanently wedge the chain. Adds a regression test that fails CI on any future migration that introduces the same bug class. Closes C14.
