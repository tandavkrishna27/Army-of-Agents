// "tenant" = the multi-tenant Organization (the account that owns companies +
// billing). Named to avoid the misleading `pendingOrganization`, which — despite
// its name — actually stores the pending *Company* created in OrgStep.
export type ConfirmedPendingTenant = { id: string; name: string };
export type PendingTenantAttempt = { creationRequestId: string; name: string };
export type PendingTenant = ConfirmedPendingTenant | PendingTenantAttempt;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isConfirmedPendingTenant(
  tenant: PendingTenant | null,
): tenant is ConfirmedPendingTenant {
  return tenant !== null && "id" in tenant;
}

export function pendingTenantKey(userId: string): string {
  return `aoa.onboarding.pendingTenant.${userId}`;
}

export function readPendingTenant(userId: string): PendingTenant | null {
  try {
    const raw = localStorage.getItem(pendingTenantKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.id === "string" && typeof parsed.name === "string") {
      return { id: parsed.id, name: parsed.name };
    }
    if (
      typeof parsed.creationRequestId === "string" &&
      UUID.test(parsed.creationRequestId) &&
      typeof parsed.name === "string"
    ) {
      return { creationRequestId: parsed.creationRequestId, name: parsed.name };
    }
    return null;
  } catch {
    return null;
  }
}

export function writePendingTenant(userId: string, tenant: PendingTenant): void {
  try {
    localStorage.setItem(pendingTenantKey(userId), JSON.stringify(tenant));
  } catch {
    // Same-page retries still use CreateOrganizationStep's in-memory ref when
    // storage is unavailable.
  }
}

export function clearPendingTenant(userId: string): void {
  try {
    localStorage.removeItem(pendingTenantKey(userId));
  } catch {
    // A stale recovery hint is harmless: re-adopting the same org id is idempotent.
  }
}
