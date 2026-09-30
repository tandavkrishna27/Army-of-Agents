import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Regenerates the committed dependency-audit fixture from the live published
// catalog. Run this ONLY when the marketplace catalog is bumped:
//
//   pnpm fetch-catalog:audit-fixture
//
// It projects id/type/status/requires for EVERY item (all skills included, so
// the audit's orphan detection is real, never vacuous) into a small, readable
// fixture consumed by server/src/__tests__/marketplace-dependency-audit.test.ts.
//
// Deliberately NOT wired into prebuild: the committed fixture must stay stable
// during CI builds so the audit catches drift, rather than silently absorbing
// it. Unlike fetch-bundled-catalog.ts there is NO empty fallback — a CDN failure
// must fail loudly rather than write an agent-less fixture that greens vacuously.

const CDN_URL =
  process.env.AOA_CATALOG_CDN_URL ??
  "https://meteoritelabs.github.io/aoa-marketplace-cdn/catalog.json";
const OUTPUT_PATH = join(
  import.meta.dirname,
  "..",
  "server",
  "src",
  "__tests__",
  "__fixtures__",
  "published-catalog",
  "catalog-index.json",
);

type Item = { id: string; type: string; status: string; requires?: unknown };

async function main() {
  console.log(`Fetching catalog for audit fixture from ${CDN_URL}`);
  const res = await fetch(CDN_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  const catalog = JSON.parse(await res.text()) as {
    schemaVersion?: string;
    generatedAt?: string;
    items?: Item[];
  };

  const items = (catalog.items ?? []).map((i) => ({
    id: i.id,
    type: i.type,
    status: i.status,
    ...(i.requires ? { requires: i.requires } : {}),
  }));

  // Safety: refuse to write a degraded/agent-less catalog (the audit would
  // otherwise green vacuously with zero edges to resolve).
  if (!items.some((i) => i.type === "agent")) {
    throw new Error("Refusing to write an agent-less catalog fixture (catalog degraded?)");
  }

  const out = {
    schemaVersion: catalog.schemaVersion,
    generatedAt: catalog.generatedAt,
    items,
  };
  writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${items.length} items to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
