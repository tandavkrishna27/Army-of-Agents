// server/src/__tests__/provider-connections-schema.test.ts
import { describe, it, expect } from "vitest";
import { providerConnections, providerAssignments } from "@armyofagents/db";

describe("provider_connections schema", () => {
  it("exposes the expected columns on providerConnections", () => {
    const cols = Object.keys(providerConnections);
    for (const c of [
      "id", "organizationId", "companyId", "provider", "authMethod",
      "ownerUserId", "executionTargetId", "secretRef", "state", "sharingPolicy",
      "maxConcurrency", "config", "termsAttestedAt", "verifiedAt", "revokedAt",
      "suspendedAt", "createdByUserId", "createdAt", "updatedAt",
    ]) {
      expect(cols).toContain(c);
    }
  });

  it("exposes the expected columns on providerAssignments", () => {
    const cols = Object.keys(providerAssignments);
    for (const c of [
      "id", "organizationId", "companyId", "connectionId", "provider",
      "scopeType", "scopeId", "priority", "state", "createdAt", "updatedAt",
    ]) {
      expect(cols).toContain(c);
    }
  });
});
