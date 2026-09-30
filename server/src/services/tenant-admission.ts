// server/src/services/tenant-admission.ts
//
// TEN-006b — sentinel/unmapped Organization admission-denial helper.
//
// AUTHORITY for the forbidden sentinel values: FND-007,
// docs/architecture/distributed-execution-legacy-parity.json:15-19
// (`forbiddenOrganizationSentinels`, locked by Decision #121). The two values are
// mirrored below EXACTLY — if FND-007 changes, this list changes with it:
//   - "00000000-0000-0000-0000-000000000001" — the DEFAULT_ORGANIZATION_ID
//     sentinel (@armyofagents/shared). Under E2-D07's dual identity this value is
//     ALSO the legitimate single-tenant Default Org: it is fine for a legacy
//     company row to EXIST on it, but it must NEVER be admitted to distributed
//     execution.
//   - "org_00000000000000000000000000" — its nil-ULID fixture-namespace form.
//
// SCOPE AT E2 (E2-D07): this helper enforces the SENTINEL rejection ONLY, and is
// DORMANT — it has NO runtime caller at E2 (do NOT wire it into any route,
// scheduler, or repository here). The UNMAPPED (Organization-does-not-exist) check
// and the end-to-end submit/place/lease wiring are E3 (JOB-001/JOB-010), which will
// call `assertAdmissibleOrganization` before persistence. At E2, "an unmapped Org
// cannot own new-path objects" is enforced structurally by `organization_id NOT
// NULL` on the new-path tables (TEN-001/004) plus this helper's unit proof.
//
// A blank/empty/whitespace-only id is intentionally NOT rejected here: emptiness is
// an "unmapped/does-not-exist" concern owned by E3, not a sentinel match.

/**
 * Thrown by {@link assertAdmissibleOrganization} when an Organization id matches a
 * forbidden distributed-admission sentinel (FND-007). Carries the offending id so
 * the E3 admission path can audit the denial without re-deriving it.
 */
export class ForbiddenOrganizationSentinelError extends Error {
  /** SQLSTATE-style discriminant for structured handling by E3 callers. */
  readonly code = "FORBIDDEN_ORGANIZATION_SENTINEL";
  /** The (verbatim) Organization id that was rejected. */
  readonly organizationId: string;

  constructor(organizationId: string) {
    super(
      `Organization "${organizationId}" is a forbidden distributed-admission sentinel ` +
        `(FND-007 forbiddenOrganizationSentinels) and cannot be admitted to distributed execution.`,
    );
    this.name = "ForbiddenOrganizationSentinelError";
    this.organizationId = organizationId;
  }
}

/**
 * The forbidden Organization sentinels, mirroring FND-007's
 * `forbiddenOrganizationSentinels` EXACTLY (readonly, frozen). Order-insensitive.
 */
export const FORBIDDEN_ORGANIZATION_SENTINELS: readonly string[] = Object.freeze([
  "org_00000000000000000000000000",
  "00000000-0000-0000-0000-000000000001",
]);

// Case/whitespace-insensitive lookup set. A caller may pass a padded or
// upper-cased form (e.g. from an env var or header); the match must still fire.
const NORMALIZED_SENTINELS: ReadonlySet<string> = new Set(
  FORBIDDEN_ORGANIZATION_SENTINELS.map((value) => value.trim().toLowerCase()),
);

/**
 * True iff `orgId` is one of the FND-007 forbidden sentinels (matched
 * case-insensitively and ignoring surrounding whitespace). Does NOT judge whether
 * a non-sentinel Organization exists — that "unmapped" check is E3.
 */
export function isForbiddenOrganizationSentinel(orgId: string): boolean {
  if (typeof orgId !== "string") return false;
  return NORMALIZED_SENTINELS.has(orgId.trim().toLowerCase());
}

/**
 * Throws {@link ForbiddenOrganizationSentinelError} if `orgId` is a forbidden
 * distributed-admission sentinel; otherwise returns void. At E2 this is the SOLE
 * admission check (sentinel-only); E3 (JOB-001/JOB-010) adds the unmapped-Org
 * existence check and wires this into submit/place/lease.
 */
export function assertAdmissibleOrganization(orgId: string): void {
  if (isForbiddenOrganizationSentinel(orgId)) {
    throw new ForbiddenOrganizationSentinelError(orgId);
  }
}

export class TenantAdmissionDeniedError extends Error {
  readonly code = "TENANT_ADMISSION_DENIED";

  constructor() {
    super("Job submission denied");
    this.name = "TenantAdmissionDeniedError";
  }
}

/**
 * E3 (JOB-010) admission gate over a RESOLVED Company→Organization edge.
 *
 * `resolveCompanyOrganizationId` returns `null` for a company that owns no
 * Organization edge — the "unmapped Organization" case E2 deferred to E3. This helper
 * layers that unmapped check on top of the sentinel rejection and collapses BOTH into
 * the single opaque {@link TenantAdmissionDeniedError} (a 403 that never leaks which
 * check failed):
 *   - `null`/blank Organization  → unmapped → denied.
 *   - forbidden sentinel Org     → denied (the sentinel is a real single-tenant Org
 *                                  that must never be admitted to distributed execution).
 *
 * On success it narrows the argument to a non-empty admissible `string`, so the bridge
 * can open `runInTenant` with a proven Organization context. The sentinel-only
 * {@link assertAdmissibleOrganization} stays unchanged (still the E2 unit contract).
 */
export function assertAdmissibleMappedOrganization(
  organizationId: string | null | undefined,
): asserts organizationId is string {
  if (typeof organizationId !== "string" || organizationId.trim() === "") {
    throw new TenantAdmissionDeniedError();
  }
  try {
    assertAdmissibleOrganization(organizationId);
  } catch (error) {
    if (error instanceof ForbiddenOrganizationSentinelError) {
      throw new TenantAdmissionDeniedError();
    }
    throw error;
  }
}
