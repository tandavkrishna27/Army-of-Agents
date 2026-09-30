# E2E test fixtures

Frozen test data so e2e assertions don't depend on production-system drift.

## `marketplace-catalog.json`

A pinned snapshot of the AoA marketplace catalog used by [`tests/e2e/marketplace.spec.ts`](../marketplace.spec.ts).

**Captured:** 2026-05-04 from `https://meteoritelabs.github.io/aoa-marketplace-cdn/catalog.json` (then `generatedAt` pinned to `2026-05-01T00:00:00.000Z` for stability).

**Items (5):** Discord, GitHub Issues, Slack, Telegram, template-skill.

### How it's used

`pr.yml`'s `e2e` job copies this file over `ui/src/aoa-marketplace-snapshot.json` after `pnpm build` runs the prebuild fetch. The server reads the snapshot lazily on first `/api/marketplace/catalog` request, so the override before `Run e2e tests` is sufficient — there's no race.

### When to update

| Trigger | Required action |
|---|---|
| `MarketplaceCatalogFileSchema` (in [`packages/shared/src/marketplace.ts`](../../../packages/shared/src/marketplace.ts)) bumps `schemaVersion` to `2.0.0` | Re-capture from CDN, update fixture; check that all assertions still find their elements. |
| Tests start asserting NEW fields on items (e.g., adding a `pricingTier` check) | Either add the field to fixture items, or have the test mock specific items inline |
| Tests add a new item type beyond plugin/skill/agent/team | Add at least one fixture item of the new type |
| Test asserts a SPECIFIC item by name (e.g., the existing "Slack heading visible") | Keep that item in the fixture or update the test to match what's there |

### When NOT to update

- The CDN catalog publishes new items — fixture stays frozen on purpose.
- Item ordering in CDN changes — fixture preserves a known order.
- Item descriptions / versions in CDN change — fixture preserves a known shape.

### Source of truth for the schema

[`packages/shared/src/marketplace.ts`](../../../packages/shared/src/marketplace.ts) — `MarketplaceCatalogFileSchema`. The Zod parse runs on the server side when the snapshot loads; if the fixture diverges from the schema, expect a runtime parse error visible in the e2e job's server logs.
