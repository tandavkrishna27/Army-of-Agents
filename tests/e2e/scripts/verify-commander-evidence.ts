import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  commanderManifestRequirements,
  validateCommanderExecutionManifest,
  type CommanderTestExecutionManifest,
} from "../../../packages/shared/src/testing/commander-execution.js";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const campaignId = argument("campaign-id") ?? process.env.AOA_COMMANDER_CAMPAIGN_ID;
if (!campaignId) throw new Error("Expected --campaign-id <id> or AOA_COMMANDER_CAMPAIGN_ID");

const path = resolve(".aoa-qa", "commander", campaignId, "results", "test-execution-manifest.json");
const manifest = JSON.parse(await readFile(path, "utf8")) as CommanderTestExecutionManifest;
const errors = validateCommanderExecutionManifest(manifest, commanderManifestRequirements(manifest.mode));

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Commander evidence verified: ${campaignId} (${manifest.entries.length} entries)`);
}
