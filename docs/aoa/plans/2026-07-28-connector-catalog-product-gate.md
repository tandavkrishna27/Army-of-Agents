# Connector Catalog Product Gate

**Status:** Split from testing incident; product validation required
**Repositories:** `MeteoriteLabs/AoA`, `MeteoriteLabs/aoa-marketplace`,
`MeteoriteLabs/aoa-marketplace-cdn`

## Problem

The public `connectors.json` returns 404 even though AoA already implements a
separate connector-catalog parser, bundled snapshot, cache precedence, and
connector UI. Publishing an artifact is mechanically straightforward; proving
that the launch set creates a useful, governable product is not.

## Decision Gates

1. Resolve the product taxonomy conflict between outbound MCP tool servers and
   the roadmap's bidirectional "Service Connectors".
2. Choose one golden founder workflow and measure browse -> install -> bind ->
   successful invocation.
3. Define launch thresholds for activation, median setup time, invocation
   success, seven-day reuse, and support incidents.
4. Decide whether AoA owns a bespoke catalog or acts as the governed trust layer
   over the official MCP Registry with a small recommended set.
5. Define admission and retention: pinned provenance, health/schema checks,
   permission-expansion reapproval, emergency denylist, quarantine, delisting
   SLA, and ownership-transfer response.
6. Keep publication testing-only until the runtime kill switch and audit story
   match the connector's data-access risk.

## Existing Leverage

- `packages/shared/src/mcp-connector-catalog.ts`
- connector catalog isolation and fallback tests
- build-time bundled connector snapshot fetch
- connector marketplace UI and company/agent binding primitives

## Validation Spike

Use one installable connector and one real founder job. The spike succeeds only
when a founder completes the job without hand-editing config and repeats it
within seven days. OAuth-only or parameter-incomplete entries remain hidden,
not visible-but-uninstallable.

## Stop Condition

Do not fund broad aggregation/publication if the golden workflow misses the
pre-committed activation or reuse threshold. A technically valid catalog with
no repeated founder value is not a launch.

## Deferred Implementation

The detailed B0/B1 builder, contract-bundle, and publication notes remain in
`archive/2026-07-28-testing-marketplace-recovery-and-followups-umbrella.md`
until this product gate is approved and re-reviewed.
