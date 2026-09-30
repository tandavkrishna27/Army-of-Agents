import { describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GOLDEN_JOURNEY_FIXTURES } from "../index.js";

// The on-disk golden-journey corpus lives here (same dir the contract-self suite
// loads from). `schema-v1.json` is the shared fixture schema, not a journey
// fixture, so it is the ONE excluded name.
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "distributed-execution",
);

const SCHEMA_FILE = "schema-v1.json";

/** The set of golden-journey fixture file names actually present on disk:
 * every `*.json` in the corpus dir MINUS the shared schema file. */
async function onDiskCorpus(): Promise<string[]> {
  const entries = await readdir(FIXTURES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json") && e.name !== SCHEMA_FILE)
    .map((e) => e.name)
    .sort();
}

describe("golden-corpus drift guard — the hardcoded list MUST equal the on-disk set", () => {
  // FIX 2/3/6: without this guard a fixture ADDED to
  // tests/fixtures/distributed-execution/ is silently uncovered by the contract
  // suite (which enumerates only GOLDEN_JOURNEY_FIXTURES). This asserts SET
  // EQUALITY in BOTH directions so an addition, a rename, OR a removal all fail
  // closed here rather than being missed.
  it("the on-disk fixture set exactly equals GOLDEN_JOURNEY_FIXTURES (catches add/rename/remove)", async () => {
    const onDisk = await onDiskCorpus();
    const enumerated = [...GOLDEN_JOURNEY_FIXTURES].sort();

    // Direct set equality: catches any divergence (extra file, missing file, or a
    // rename — which is simultaneously a missing old name and an extra new name).
    expect(onDisk).toEqual(enumerated);

    // Explicit both-directions membership + cardinality, so a failure names the
    // exact drift rather than only a diff.
    const onDiskSet = new Set(onDisk);
    const enumeratedSet = new Set(enumerated);
    const addedOnDisk = onDisk.filter((name) => !enumeratedSet.has(name));
    const missingFromDisk = enumerated.filter((name) => !onDiskSet.has(name));
    expect(addedOnDisk, `fixtures on disk but NOT in GOLDEN_JOURNEY_FIXTURES: ${addedOnDisk.join(", ")}`).toEqual([]);
    expect(missingFromDisk, `fixtures enumerated but MISSING on disk: ${missingFromDisk.join(", ")}`).toEqual([]);
    expect(onDisk.length).toBe(enumerated.length);
    // The corpus is the nine frozen FND-004 journeys.
    expect(enumerated.length).toBe(9);
  });
});
