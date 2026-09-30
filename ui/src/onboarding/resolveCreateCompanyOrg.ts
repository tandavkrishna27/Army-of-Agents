import type { OrganizationMembership } from "../api/organizations";

/**
 * Fix 2 (design P1). Given the caller's org memberships (GET /organizations =
 * organizationsApi.list()), decide which Organization a *new* company should be
 * created under. Only owner/admin may create companies (the MATRIX in
 * server/src/services/organization-access.ts), so filter to those
 * "create-capable" roles first:
 *   - exactly one create-capable org -> "org": auto-pick it silently.
 *   - zero                           -> "needs-org": mint one first
 *                                       (CreateOrganizationStep).
 *   - two or more                    -> "ambiguous": a friendly message, not a
 *                                       picker (YAGNI in the beta).
 * The "org" case always carries a concrete id — cloud_auth requires an explicit
 * organizationId (the server never guesses for a >=2-org founder).
 */
export type CreateCompanyOrgResolution =
  | { kind: "org"; organizationId: string }
  | { kind: "needs-org" }
  | { kind: "ambiguous"; organizationIds: string[] };

const CREATE_CAPABLE_ROLES: ReadonlySet<OrganizationMembership["role"]> = new Set([
  "owner",
  "admin",
]);

export function resolveCreateCompanyOrg(
  memberships: OrganizationMembership[],
): CreateCompanyOrgResolution {
  const organizationIds = [
    ...new Set(
      memberships
        // Match the server's canOrg gate: only an ACTIVE membership in a
        // create-capable role can create a company. Filtering status here keeps
        // the resolver self-contained (a suspended owner must not be miscounted).
        .filter(
          (membership) =>
            membership.status === "active" && CREATE_CAPABLE_ROLES.has(membership.role),
        )
        .map((membership) => membership.organizationId),
    ),
  ];
  if (organizationIds.length === 1) {
    return { kind: "org", organizationId: organizationIds[0]! };
  }
  if (organizationIds.length === 0) return { kind: "needs-org" };
  return { kind: "ambiguous", organizationIds };
}
