// -----------------------------------------------------------------------------
// Golden-journey corpus enumeration + provider-neutral op vectors.
//
// `GOLDEN_JOURNEY_FIXTURES` mirrors the frozen FND-004 corpus (the checker's
// internal `GJ_FIXTURES` list, which is NOT exported — see the DEP-000 result
// note). The conformance suite loads these by name from a caller-supplied
// fixtures directory to prove the corpus is present and parseable; the DRIVER
// contract itself runs on the provider-neutral op vectors below, never on tenant
// fixture fields.
// -----------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import path from "node:path";

/** The nine frozen golden-journey fixture file names (FND-004 corpus). */
export const GOLDEN_JOURNEY_FIXTURES = [
  "batch-success.json",
  "batch-cancel-during-execution.json",
  "browser-approval-download.json",
  "browser-denied-egress.json",
  "service-restart-checkpoint.json",
  "service-budget-stop.json",
  "service-provider-pause-resume.json",
  "late-output-quarantine.json",
  "plaintext-secret-in-argv-rejected.json",
] as const;

export type GoldenJourneyFixtureName = (typeof GOLDEN_JOURNEY_FIXTURES)[number];

/** Load and parse a single golden-journey fixture from `fixturesDir`. */
export async function loadGoldenFixture(
  fixturesDir: string,
  name: GoldenJourneyFixtureName,
): Promise<Record<string, unknown>> {
  const text = await readFile(path.join(fixturesDir, name), "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`golden fixture ${name} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
