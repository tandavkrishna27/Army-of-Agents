export type ConfirmedPendingOrganization = { id: string; name: string };
export type PendingOrganizationAttempt = {
  creationRequestId: string;
  name: string;
  organizationId?: string;
};
export type PendingOrganization = ConfirmedPendingOrganization | PendingOrganizationAttempt;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isConfirmedPendingOrganization(
  company: PendingOrganization | null,
): company is ConfirmedPendingOrganization {
  return company !== null && "id" in company;
}

export function pendingOrganizationKey(userId: string): string {
  return `aoa.onboarding.pendingOrganization.${userId}`;
}

export function readPendingOrganization(userId: string): PendingOrganization | null {
  try {
    const raw = localStorage.getItem(pendingOrganizationKey(userId));
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
      return {
        creationRequestId: parsed.creationRequestId,
        name: parsed.name,
        ...(typeof parsed.organizationId === "string"
          ? { organizationId: parsed.organizationId }
          : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writePendingOrganization(
  userId: string,
  company: PendingOrganization,
): void {
  try {
    localStorage.setItem(pendingOrganizationKey(userId), JSON.stringify(company));
  } catch {
    // Same-page retries still use OrgStep's in-memory ref when storage is unavailable.
  }
}

export function clearPendingOrganization(userId: string): void {
  try {
    localStorage.removeItem(pendingOrganizationKey(userId));
  } catch {
    // A stale recovery hint is harmless: replaying the advance is idempotent.
  }
}
