# Marketplace Supply-Chain Recovery

**Date:** 2026-07-29

**Repositories:** `MeteoriteLabs/AoA`, `MeteoriteLabs/aoa-marketplace`,
`MeteoriteLabs/aoa-marketplace-cdn`

**Target:** `https://testing.armyofagents.org`

## Outcome

Make the deployed marketplace reflect the curated source without duplicated or
misclassified cards, make Default Crew navigation deterministic, make recovery
maintenance deterministic after a cold start, and publish the first governed
connector artifact through the marketplace producer rather than by editing the
CDN mirror.

## Confirmed Root Causes

1. The AoA shelf is classified by publisher/owner. That moves every first-party
   plugin and standalone agent out of its normal type shelf.
2. The AoA view suppresses packages, so the server-derived
   `MeteoriteLabs/aoa-marketplace` skills package cannot be seen.
3. `/marketplace/team/aoa-curated/default-crew` collides with
   `/:companyPrefix/team/:userId/:tab` in React Router and is interpreted as a
   company route.
4. Reviewer exists in the marketplace team template, but testing has an
   unreconciled legacy crew with no marketplace team row.
5. The recovery preflight authenticates `/api/cli-auth/me` but calls the
   board-protected `/api/marketplace/catalog/status` endpoint anonymously.
6. Startup crew maintenance reads the cache while the initial catalog sync is
   still running. A cold-cache miss then defers the next pass for 24 hours.
7. GitHub Pages and the CDN repository are healthy. `connectors.json` returns
   404 because the marketplace repository has never generated or published it.

## Product Taxonomy

There is no duplication between the AoA shelf and the normal type shelves.

| Shelf | Visible content |
|---|---|
| AoA | AoA skills package, Default Crew, and the ten agents required by Default Crew |
| Plugins | The four AoA plugins |
| Agents | Senior Engineer and GitHub Issue Triager |
| Teams | Future non-default teams; Default Crew is excluded |
| Skills | Community packages/items; the two AoA package members are represented by the AoA package card |
| Connectors | Separate `connectors.json` contract |

Crew membership is derived from the published
`team:aoa-curated/default-crew.requires` relationship. It is not duplicated in a
UI name list.

The Default Crew card and its legacy marketplace detail URL both lead directly
to the selected company's AoA roster:

```text
/<company-prefix>/team?tab=aoa&aoaTab=roster
```

## Delivery Units

### PR 1: AoA consumer and recovery controls

1. Replace publisher-wide shelf segregation with a pure relationship-derived
   placement helper.
2. Render the AoA package in the AoA shelf and hide its individual member cards.
3. Route Default Crew directly to the company AoA roster and add a static route
   for existing deep links.
4. Authenticate the catalog-status recovery preflight request.
5. Make startup maintenance join the registered catalog service's initial sync
   instead of performing a cache-only read.
6. Add connector runtime controls before publication:
   - a catalog/runtime kill switch;
   - a delivery-time emergency denylist by validated server name;
   - matching install/shelf refusal so disabled entries cannot be newly added.
7. Correct Decision #116 and export a versioned connector contract bundle:
   JSON Schema, raw-input conformance cases, and a SHA-256 manifest.

### PR 2: Marketplace producer and publication

1. Strengthen Default Crew validation to require the exact ten published
   members across manifest dependencies, team body, install order, and active
   catalog items.
2. Correct stale marketplace documentation.
3. Add `content/connectors/<slug>/connector.json`.
4. Add an all-or-nothing connector aggregator:
   - deterministic ordering and output;
   - consumer-contract and conformance validation;
   - duplicate ID and server-name rejection;
   - reserved-name rejection;
   - transport coherence;
   - value-bearing credential-field rejection;
   - trust derived from reviewed source metadata, never content self-assertion.
5. Keep the ordinary nightly catalog publisher unchanged.
6. Add a manual, artifact-pinned connector publisher with:
   - `source_sha`, `artifact_sha256`, and `dry_run` inputs;
   - detached checkout of the exact source SHA;
   - exact digest regeneration;
   - a connectors-only CDN diff;
   - provenance in the generated commit/PR;
   - rollback to a previously valid envelope, never deletion/404.

The CDN repository remains a generated mirror. It is never edited as a source
repository.

## First Connector and Product Proof

The first installable connector is Context7 over remote HTTP:

```text
https://mcp.context7.com/mcp
```

It is the golden workflow for current software documentation:

```text
browse -> install -> assign -> agent invokes resolve-library-id -> result
```

Primary-source documentation identifies the endpoint, and a credential-free
MCP initialize, `tools/list`, and `tools/call` completed successfully on
2026-07-29. The initial entry therefore requires no secret. No OAuth-only or
unverified local-command connector is included in the first live artifact.

## Rollout

1. Merge both source PRs only after targeted and full repository gates pass.
2. Deploy the exact merged AoA SHA to testing.
3. Exercise the connector artifact through the local file seam before public
   publication.
4. Run the connector publisher in `dry_run` mode and review the generated bytes,
   digest, and connectors-only CDN diff.
5. Publish the exact reviewed digest.
6. Wait for GitHub Pages to serve the exact CDN commit and verify HTTP 200,
   JSON content type, and byte digest.
7. Reconcile testing explicitly.
8. Verify the route/shelf matrix and the golden connector invocation.

## Rollback

1. Connector emergency: activate the runtime kill switch or denylist first so
   already-installed connectors stop being delivered.
2. Republish the last-known-good valid `connectors.json`. For a first-release
   rollback, publish a valid empty envelope; never delete the file because
   clients preserve last-known-good data on fetch failure.
3. Revert the marketplace producer/content change independently.
4. Redeploy the last exact, contract-aware AoA SHA if the consumer UI or recovery
   path regresses.

## Acceptance Criteria

- AoA shows exactly one package card, Default Crew, and its ten crew agents.
- Plugins shows four cards; Agents shows two; Teams does not duplicate Default
  Crew.
- Default Crew navigation lands on the selected company roster.
- Recovery preflight succeeds with a board API key and no fabricated browser
  origin.
- Cold-start maintenance waits for the first catalog resolution and can add a
  missing Reviewer without waiting 24 hours.
- Connector producer validation is all-or-nothing.
- Public `connectors.json` is generated from a reviewed marketplace source SHA
  and its digest matches the publisher input.
- Testing completes browse, install, assignment, and a real Context7 MCP tool
  call.
- Activating the kill switch or denylist prevents both new installation and
  runtime delivery.

## Verification

AoA:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Marketplace:

```sh
pnpm --filter @armyofagents/aoa-marketplace-builder typecheck
pnpm --filter @armyofagents/aoa-marketplace-builder test
pnpm aggregate
pnpm validate
```

Publication:

```text
dry-run digest == reviewed artifact digest
CDN diff changes connectors.json and its provenance only
live GET digest == reviewed artifact digest
```
