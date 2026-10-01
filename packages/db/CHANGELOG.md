# @armyofagents/db

## 1.0.1

### Patch Changes

- 40688fc: feat(db): add `0115_enable_pgvector.sql` preflight migration that runs `CREATE EXTENSION IF NOT EXISTS vector` ahead of any future vector-column migrations (Thread-Native Agent Coordination Pre-Task 0.5). Wrapped in `DO $$ ... EXCEPTION` so it no-ops on installs without pgvector (embedded-postgres bundle, CI postgres:16) and only enables the extension where the binary is available. Memory semantic-search paths remain gated by `probeDbCapabilities()`.
- 40688fc: fix(db): add `IF NOT EXISTS` to every `CREATE TABLE` / `CREATE INDEX` / `CREATE UNIQUE INDEX` in the 9 migration files that pre-dated PR #121's fix on 0080. Prevents the half-applied-migration footgun in `applyPendingMigrationsManually` (`packages/db/src/client.ts:222`) where a partially-applied migration with one new + one existing object would permanently wedge the chain. Adds a regression test that fails CI on any future migration that introduces the same bug class. Closes C14.
- 40688fc: feat(db): add HNSW index on `memory_items.embedding` for fast cosine-distance semantic memory retrieval. Closes C12 (the index was claimed in CLAUDE.md but never existed). Conditional on pgvector being installed; partial index skips NULL rows. HNSW chosen over IVFFlat for AoA's incremental ingest pattern. CLAUDE.md updated to reflect reality.
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
  - @armyofagents/shared@1.0.1

## 0.2.7

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.7

## 0.2.6

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.6

## 0.2.5

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.5

## 0.2.4

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.4

## 0.2.3

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.3

## 0.2.2

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.2

## 0.2.1

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.1
