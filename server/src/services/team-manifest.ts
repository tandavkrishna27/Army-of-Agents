import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { TeamManifestSchema, type TeamManifest } from "@armyofagents/shared";
import { badRequest } from "../errors.js";

export function parseManifest(yaml: string): TeamManifest {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    // P2: client-correctable input → 400, not 500. The route layer would
    // otherwise see a plain Error and the global error handler would emit a
    // generic 500.
    throw badRequest(`malformed YAML: ${(err as Error).message}`);
  }
  return validateManifest(raw);
}

export function validateManifest(raw: unknown): TeamManifest {
  const result = TeamManifestSchema.safeParse(raw);
  if (!result.success) {
    // P2: schema/regex violations (caught by TeamManifestSchema.superRefine
    // — D2 moved the regex check into Zod) are client-correctable. Surface
    // them as 400 so YAML import + service-level callers don't bubble up as
    // 500. Route-layer `validate(...)` already turns Zod errors into 400
    // for JSON inputs; this path covers parseManifest from YAML imports.
    throw badRequest(`invalid manifest: ${result.error.message}`);
  }
  // Regex compilability is now validated by TeamManifestSchema.superRefine
  // (D2: consolidates dual validation into the schema layer).
  return result.data;
}

export function serializeManifest(manifest: TeamManifest): string {
  validateManifest(manifest);
  return stringifyYaml(manifest);
}
