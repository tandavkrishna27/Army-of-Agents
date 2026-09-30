// Relative import of the pure shared auditor: scripts/ is not a workspace
// package, so the bare "@armyofagents/shared" specifier is not resolvable here
// (Node walks up from this file's dir and finds no linked package). The module
// is dependency-free, so importing its source directly via tsx is clean.
import {
  auditCatalogDependencies,
  type CatalogAuditItem,
} from "../packages/shared/src/marketplace-dependency-audit.ts";

// Live-CDN dependency advisory. Fetches the marketplace catalog that is ACTUALLY
// PUBLISHED (not the committed fixture) and audits every agent/team `requires`
// edge, so an upstream removal/deprecation is caught even between fixture
// refreshes. Exits non-zero on any orphan.
//
// Deliberately NOT part of the required `verify` gate — that gate audits a
// committed fixture offline (marketplace-dependency-audit.test.ts) so it never
// depends on CDN availability. This runs as a scheduled advisory
// (.github/workflows/catalog-audit.yml) or on demand via `pnpm audit-catalog`.

const CDN_URL =
  process.env.AOA_CATALOG_CDN_URL ??
  "https://meteoritelabs.github.io/aoa-marketplace-cdn/catalog.json";

async function main() {
  console.log(`Auditing live marketplace catalog: ${CDN_URL}`);
  const res = await fetch(CDN_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  const catalog = JSON.parse(await res.text()) as { items?: CatalogAuditItem[] };
  const items = catalog.items ?? [];

  const agents = items.filter((i) => i.type === "agent").length;
  const team = items.find((i) => i.id === "team:aoa-curated/default-crew");
  const edges = items
    .filter((i) => i.type === "agent" || i.type === "team")
    .reduce((n, i) => n + (i.requires?.length ?? 0), 0);

  // Non-vacuity floors (mirror the committed-fixture test). A PARTIALLY-degraded
  // CDN response — agents present but the crew team dropped or every `requires`
  // array stripped — would leave zero edges and pass with no orphans to
  // classify. Refuse a vacuous green. Floors sit under real values
  // (12 agents / 27 team edges / 70 total).
  if (agents < 10 || !team || (team.requires?.length ?? 0) < 25 || edges < 40) {
    throw new Error(
      "Live catalog looks degraded — refusing a vacuous pass " +
        `(agents=${agents}, defaultCrew=${team ? "present" : "MISSING"}, ` +
        `teamEdges=${team?.requires?.length ?? 0}, totalEdges=${edges}).`,
    );
  }

  const orphans = auditCatalogDependencies({ items });

  console.log(`Catalog: ${items.length} items, ${agents} agents, ${edges} agent/team requires edges.`);

  if (orphans.length > 0) {
    console.error(`\n❌ ${orphans.length} orphaned dependency edge(s) in the LIVE catalog:`);
    for (const o of orphans) {
      console.error(`  ${o.owner} -> ${o.reason} ${o.requiredType} ${o.requiredId}`);
    }
    console.error(
      "\nAn agent/team requires an item that is missing / wrong-type / not-active upstream. " +
        "New-company provisioning may degrade. Fix the upstream catalog, then refresh the audit " +
        "fixture (pnpm fetch-catalog:audit-fixture).",
    );
    process.exit(1);
  }
  console.log(`✅ All ${edges} dependency edges resolve. No orphans.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
