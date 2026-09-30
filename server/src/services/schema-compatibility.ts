/**
 * DEP-003 (E6 deployment harness): the schema-compatibility gate that backs
 * readiness. The control plane serves NO tenant/app route until the applied
 * migration identity is COMPATIBLE with the image's
 * `loadRequiredMigrationIdentity()`. This module is the pure comparison core plus a
 * thin DB loader; the readiness route + startup gate consume it.
 *
 * Three verdicts:
 *   - `compatible`   — applied == required. Ready to serve.
 *   - `pending`      — applied is a strict PREFIX of required (DB behind the image;
 *                      the migration job has not finished). Readiness 503s until the
 *                      privileged migration job applies the rest — NOT a crash.
 *   - `incompatible` — the DB was migrated PAST this image (`newer`, the rollback
 *                      case) or diverged (`divergent`). Refuse to serve.
 */
import {
  loadAppliedMigrationIdentity,
  loadRequiredMigrationIdentity,
} from "@armyofagents/db";

export interface SchemaCompatibilityInput {
  /** Image's required migration file hashes (journal order), from loadRequiredMigrationIdentity. */
  requiredOrderedHashes: readonly string[];
  /** sha256 of each APPLIED migration file that resolves to this image, in apply order. */
  appliedOrderedHashes: readonly string[];
  /** Raw `__drizzle_migrations` row count — reveals a DB migrated past this image. */
  rawAppliedCount: number;
}

export type SchemaCompatibility =
  | { status: "compatible"; schemaCompatible: true }
  | { status: "pending"; schemaCompatible: false; pendingCount: number }
  | { status: "incompatible"; schemaCompatible: false; reason: "newer" | "divergent" };

/**
 * The pure, deterministic compatibility verdict. Fail-closed: anything that is not
 * an exact match or a clean prefix-behind is treated as incompatible (refuse serve).
 */
export function evaluateSchemaCompatibility(
  input: SchemaCompatibilityInput,
): SchemaCompatibility {
  const requiredLen = input.requiredOrderedHashes.length;
  const applied = input.appliedOrderedHashes;

  // A DB with MORE applied migrations than the image knows (or more raw rows than
  // the image's whole ledger) has been migrated by a newer image — refuse to serve.
  if (input.rawAppliedCount > requiredLen || applied.length > requiredLen) {
    return { status: "incompatible", schemaCompatible: false, reason: "newer" };
  }

  // The applied hashes must be an exact positional PREFIX of the required hashes.
  // Any mismatch means a replaced/diverged migration -> refuse to serve.
  for (let i = 0; i < applied.length; i += 1) {
    if (applied[i] !== input.requiredOrderedHashes[i]) {
      return { status: "incompatible", schemaCompatible: false, reason: "divergent" };
    }
  }

  // Raw rows that did NOT resolve to image files within the known range (a diverged
  // or renamed migration) -> refuse to serve.
  if (input.rawAppliedCount !== applied.length) {
    return { status: "incompatible", schemaCompatible: false, reason: "divergent" };
  }

  if (applied.length === requiredLen) {
    return { status: "compatible", schemaCompatible: true };
  }

  // Applied is a strict prefix — the migration job has not finished. 503 until it does.
  return { status: "pending", schemaCompatible: false, pendingCount: requiredLen - applied.length };
}

/**
 * Load the applied + required identities from the DB and the image, then compare.
 * Read-only; never mutates the database.
 */
export async function loadSchemaCompatibility(url: string): Promise<SchemaCompatibility> {
  const [required, applied] = await Promise.all([
    loadRequiredMigrationIdentity(),
    loadAppliedMigrationIdentity(url),
  ]);
  return evaluateSchemaCompatibility({
    requiredOrderedHashes: required.orderedHashes,
    appliedOrderedHashes: applied.orderedHashes,
    rawAppliedCount: applied.rawAppliedCount,
  });
}
