# Universe original-intake wave results

**Date:** September 20, 2026  
**Boundary:** E4.1/1 durable human originals

## Implemented

- Application-scoped `universe_intakes` and `universe_intake_parts` ledgers with owner/client idempotency, destination binding, state revision, reserved part keys and a reserved final-object identity.
- Board-only begin/status/part/finalize/cancel routes under the authorized company.
- Four MiB verified parts and a 50 MiB declared-file ceiling. The server derives every storage key and verifies part, combined and read-back final SHA-256 values.
- Publication reauthorizes the live destination and commits one canonical asset, one published pointer and one `asset.created` activity. Repeated finalize resolves the same asset.
- Raw asset metadata, content and office-render routes now enforce the live private Commander/discussion destination for Universe originals.
- Startup and 15-minute reconciliation expire unpublished sessions and delete only their known reserved keys. Published originals are excluded.
- The browser intake panel keeps File bytes ephemeral, supports explicit canvas/message wording, tab-only intake recovery, reselect verification, missing-part resume, cancel and polite status.

## Evidence

- Focused shared/storage/UI tests: 12 passed.
- Linux real-PostgreSQL integration: 5 passed, covering idempotent begin, changed bytes, one publication/audit, owner and destination revocation, cancellation and expiry cleanup.
- Recursive server dependency typecheck and UI typecheck passed.

## Deliberate remaining boundaries

- E4.1/2 processing status and E4.2 processors/indexing remain later batches.
- S3/MinIO crash-matrix qualification remains a release gate when that backend is available; this source increment does not claim it.
- Derivative lineage access will be added with the E4.2 derivative schema. No derivative bypass route exists in this increment.
