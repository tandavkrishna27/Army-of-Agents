import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Build-time fetch of the connector catalog (`connectors.json`) into a bundled
 * snapshot, mirroring `fetch-bundled-catalog.ts`. The server's connector shelf
 * (`server/src/services/mcp-connector-catalog.ts` → `loadBundledConnectorSnapshot`)
 * uses this file as an OFFLINE/air-gapped fallback when the CDN is unreachable on
 * the very first load. Online instances fetch the live CDN and never touch it.
 *
 * Note the shape: connectors use `{ schemaVersion, entries: [...] }` — NOT the
 * catalog's `{ ..., items: [...] }`. They are separate CDN artifacts on purpose
 * (the FU-14 fleet-safety separation: one unknown item type must never freeze the
 * other catalog).
 */
const CDN_URL = process.env.AOA_CONNECTORS_CDN_URL
  ?? "https://meteoritelabs.github.io/aoa-marketplace-cdn/connectors.json";
const OUTPUT_PATH = join(import.meta.dirname, "..", "ui", "src", "aoa-connectors-snapshot.json");

async function main() {
  console.log(`Fetching bundled connectors from ${CDN_URL}`);
  let body: string;
  try {
    const res = await fetch(CDN_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    body = await res.text();
  } catch (err) {
    console.warn(`Connectors fetch failed: ${err instanceof Error ? err.message : err}`);
    if (existsSync(OUTPUT_PATH)) {
      console.warn(`Keeping existing snapshot at ${OUTPUT_PATH}`);
      return;
    }
    console.warn(`Writing empty fallback snapshot (connectors.json not published yet)`);
    body = JSON.stringify({
      schemaVersion: "1.0.0",
      generatedAt: new Date().toISOString(),
      entries: [],
    });
  }

  // Verify it parses as JSON before writing.
  JSON.parse(body);

  if (!existsSync(dirname(OUTPUT_PATH))) {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  }
  writeFileSync(OUTPUT_PATH, body);
  console.log(`Wrote bundled connectors snapshot: ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
