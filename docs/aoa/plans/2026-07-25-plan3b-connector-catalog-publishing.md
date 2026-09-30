# Plan 3b — Curated Connector Catalog + Publishing

**Date:** 2026-07-25
**Repos:** AoA (`integration/connectors-marketplace`) + `MeteoriteLabs/aoa-marketplace` (builder + content) → publishes to `MeteoriteLabs/aoa-marketplace-cdn`
**Goal:** the connector shelf shows a real, curated set of connectors to actual founders — not an empty page or a local fixture.

> **Scope note.** The user's chosen "3b" is *curated catalog + publish `connectors.json`* (make the 3a shelf real). The long-tail **registry search** from the original Plan 3 design is deferred to a later effort (Plan 3c); it is NOT this plan.

---

## 1. What's already done (AoA side)

- `DEFAULT_CONNECTOR_CATALOG_URL = https://meteoritelabs.github.io/aoa-marketplace-cdn/connectors.json` is already the read source (`server/src/services/mcp-connector-catalog.ts:60`). The shelf fetches it today; it's empty only because that file 404s.
- The whole 3a install/consent/credential/delivery pipeline consumes `McpConnectorCatalogEntry` (`packages/shared/src/mcp-connector-catalog.ts`) — the shape the builder must emit.
- `requiresOAuth` support (shown-not-installable) already lands from Wave 2.

So the AoA side needs only **one addition**: a build-time snapshot fallback for `connectors.json` (offline/air-gapped instances), mirroring `scripts/fetch-bundled-catalog.ts` → `ui/src/aoa-marketplace-snapshot.json`.

## 2. Marketplace-repo work (the bulk)

The builder (`catalog/src/aggregate.ts`) assembles `catalog.json` from source adapters, validates, resolves trust, and `publish-cdn` pushes it. Connectors are NOT catalog items (own schema, own file — the FU-14 fleet-safety reason), so they get a **parallel** pipeline:

1. **Content** — `content/connectors/<slug>/connector.json`, each matching `McpConnectorCatalogEntry`.
2. **Aggregate** — a `aggregateConnectors()` that reads `content/connectors/*`, validates each against the connector schema (shared contract), and writes `connectors.json` (`{schemaVersion, entries}`). Reuse the trust-resolver so `trust.tier` is set from `trusted-sources.json`, not self-asserted (matches the AoA-side "verified is fail-closed, never from entry metadata" rule).
3. **Validate** — extend `validate` to check connector entries (charset serverName, transport coherence, no secret VALUES in templates — only keys, `requiresOAuth`/`requiresSecret` sanity).
4. **Publish** — `publish-cdn` writes `connectors.json` alongside `catalog.json` to the CDN mirror.

**The connector-schema contract must be shared, not duplicated.** The builder validates against the SAME shape AoA's `McpConnectorCatalogEntrySchema` enforces; drift = a published entry AoA silently drops (FU-14/FU-22 already make AoA drop-and-warn, but the builder should catch it first). Options: publish the AoA schema as a package the builder imports, or a validated JSON-schema mirror with a drift check. Decide in execution.

## 3. Proposed initial curated set (~16 to start, expand later)

Following locked decisions: stdio **option A** (curated 1-click; community reveal-and-confirm), `trust.tier` fail-closed, show both Notion variants.

**Verified HTTP (token via Settings):**
- Linear · Sentry · Stripe · (others that are genuinely token-auth, not OAuth-only — verify each, several flagships are OAuth-only like Notion hosted)

**Verified stdio (local, token or none):**
- Filesystem (`@modelcontextprotocol/server-filesystem`) · SQLite · Postgres · Git · Fetch · Memory · Sequential-thinking · Time
- **Notion (local)** — `npx @notionhq/notion-mcp-server`, `NOTION_TOKEN` — **proven live 2026-07-25**

**Shown but requiresOAuth (disabled until Plan 4):**
- **Notion (hosted)** — `mcp.notion.com` · GitHub (hosted) · Linear (if OAuth-only) · Slack (if OAuth-only)

⚠ **Per-entry verification required** — for each, confirm the actual auth model (token vs OAuth-only) and the real package/URL before marking `verified`. Notion's live test proved docs-vs-reality gaps are real. A wrongly-`verified` OAuth-only HTTP entry ships a card that silently fails — the exact FU-24/FU-25 class.

## 4. The publish gate (outward-facing)

Building content + the aggregate + validation is local and committable. **Publishing to the live CDN makes connectors appear for every AoA instance that fetches the URL** — outward-facing, gated on explicit founder approval (like the PR). The plan builds and validates everything; the actual `publish-cdn` run is a final, separately-approved step.

## 5. Sequencing

1. AoA: connector snapshot-fallback script + bundled `ui/src/aoa-connectors-snapshot.json` (empty until content exists) + wire the fallback into `createConnectorCatalogService`.
2. Marketplace: connector content dir + `aggregateConnectors` + validation + `publish-cdn` extension + tests.
3. Author the curated set (§3), per-entry auth-model verified.
4. Run aggregate locally, point a dev AoA instance at the produced `connectors.json` (the E2E seam), confirm the shelf renders the real set + install works.
5. **[gated]** publish to CDN.

## 6. Risks
- **Cross-repo schema drift** — the builder must validate against AoA's connector shape. Mitigate with a shared contract + a drift test.
- **Mis-verified OAuth-only entries** — per-entry auth verification is mandatory, not optional.
- **CDN publish is fleet-wide** — gated on approval; `connectors.json` additive-field safety (FU-22) already protects older instances.
