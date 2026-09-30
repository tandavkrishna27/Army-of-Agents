import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const CDN_URL = process.env.AOA_CATALOG_CDN_URL
  ?? "https://meteoritelabs.github.io/aoa-marketplace-cdn/catalog.json";
const OUTPUT_PATH = join(import.meta.dirname, "..", "ui", "src", "aoa-marketplace-snapshot.json");

async function main() {
  console.log(`Fetching bundled catalog from ${CDN_URL}`);
  let body: string;
  try {
    const res = await fetch(CDN_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    body = await res.text();
  } catch (err) {
    console.warn(`Catalog fetch failed: ${err instanceof Error ? err.message : err}`);
    if (existsSync(OUTPUT_PATH)) {
      console.warn(`Keeping existing snapshot at ${OUTPUT_PATH}`);
      return;
    }
    console.warn(`Writing empty fallback snapshot`);
    body = JSON.stringify({
      schemaVersion: "1.0.0",
      generatedAt: new Date().toISOString(),
      itemCount: 0,
      items: [],
    });
  }

  // Verify it parses as JSON before writing
  JSON.parse(body);

  if (!existsSync(dirname(OUTPUT_PATH))) {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  }
  writeFileSync(OUTPUT_PATH, body);
  console.log(`Wrote bundled catalog snapshot: ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
