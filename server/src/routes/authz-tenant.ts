import type { Request } from "express";
import { eq } from "drizzle-orm";
import { companies, type Db } from "@armyofagents/db";
import { forbidden } from "../errors.js";

// companyId -> organizationId. A company's owning organization is immutable
// (P1 sets companies.organization_id at create and never reassigns it), so the
// mapping is process-cached. invalidateCompanyTenant() clears an entry on the
// rare paths that could change it (e.g. company delete).
const tenantCache = new Map<string, string>();

export function invalidateCompanyTenant(companyId: string): void {
  tenantCache.delete(companyId);
}

/** Test-only: clears the whole cache so cases don't leak state into each other. */
export function __resetTenantCache(): void {
  tenantCache.clear();
}

/**
 * Resolve the organization (tenant) that owns a company. Returns null when the
 * company does not exist (the caller's route then surfaces its own 404). Cached
 * because the mapping is immutable.
 */
export async function resolveCompanyTenant(db: Db, companyId: string): Promise<string | null> {
  const cached = tenantCache.get(companyId);
  if (cached) return cached;
  const row = await db
    .select({ organizationId: companies.organizationId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  const orgId = row?.organizationId ?? null;
  if (orgId) tenantCache.set(companyId, orgId);
  return orgId;
}

/**
 * Best-effort tenant resolution for storage object-key scoping. The storage
 * tenant segment (`{organizationId}/{companyId}/…`) is DEFENSE-IN-DEPTH over the
 * company boundary — companyId is a globally-unique UUID, so the company segment
 * already isolates. A resolution failure (missing/partial db handle, transient
 * error) must therefore NEVER break asset serving: we fall back to the legacy
 * company-scoped key, which the reader guard still authorizes. Never throws.
 */
export async function resolveStorageTenant(db: Db, companyId: string): Promise<string | null> {
  try {
    return await resolveCompanyTenant(db, companyId);
  } catch {
    return null;
  }
}

/**
 * Assert the request actor is a member of the given organization (tenant).
 * A null tenantId is a no-op: it means the company was not found, and the route
 * should be allowed to return its own 404 rather than a misleading 403.
 */
export function assertTenantMembership(req: Request, tenantId: string | null): void {
  if (tenantId === null) return; // missing company: let the route return its own 404
  const orgs = req.actor.organizationIds ?? [];
  if (!orgs.includes(tenantId)) throw forbidden("Actor is not a member of this organization");
}
