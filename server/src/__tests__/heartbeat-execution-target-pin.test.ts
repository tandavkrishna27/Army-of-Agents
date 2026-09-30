// Round-7 finding: the heartbeat run-scope wrapped resolveExecutionTargetForRun
// in `.catch(() => null)`, swallowing the throw even when the run carried an
// EXPLICIT execution-target pin (environmentRuntime.executionTargetId != null).
// A swallowed pin error silently fell back to the local host — Decision #117 §4
// requires an explicit pin to fail closed. This pure-helper test pins the
// contract: throw when pinned, null (local fallback) when unpinned.
import { describe, expect, it } from "vitest";
import {
  handleExecutionTargetRoutingError,
  resolveHeartbeatExecutionTargetOrganizationId,
} from "../services/heartbeat-execution-target.js";

function companyOrgDb(organizationId: string | null) {
  return {
    select: () => ({
      from: () => ({
        where: async () => (organizationId === null ? [] : [{ organizationId }]),
      }),
    }),
  } as unknown as Parameters<typeof resolveHeartbeatExecutionTargetOrganizationId>[0];
}

describe("handleExecutionTargetRoutingError — explicit pin fails closed (Decision #117 §4)", () => {
  it("re-throws when an explicit execution-target pin is unavailable", () => {
    const err = new Error("pinned execution target unavailable");
    expect(() =>
      handleExecutionTargetRoutingError(err, { hasExplicitPin: true, credentialKind: "company_api_key" }),
    ).toThrow(err);
  });

  it("returns null (local fallback) for an unpinned route-by-credential run", () => {
    const err = new Error("transient routing error");
    expect(
      handleExecutionTargetRoutingError(err, { hasExplicitPin: false, credentialKind: "company_api_key" }),
    ).toBeNull();
  });

  it("rethrows for an unpinned personal_subscription run (fails closed, Decision #117 §4)", () => {
    const err = new Error("no matching dedicated target");
    expect(() =>
      handleExecutionTargetRoutingError(err, { hasExplicitPin: false, credentialKind: "personal_subscription" }),
    ).toThrow(err);
  });

  it("returns null for an unpinned company_api_key run (local fallback unchanged)", () => {
    expect(
      handleExecutionTargetRoutingError(new Error("x"), { hasExplicitPin: false, credentialKind: "company_api_key" }),
    ).toBeNull();
  });

  it("returns null for an unpinned null-credential run (local fallback unchanged)", () => {
    expect(
      handleExecutionTargetRoutingError(new Error("x"), { hasExplicitPin: false, credentialKind: null }),
    ).toBeNull();
  });

  it("rethrows for an explicit pin regardless of credentialKind", () => {
    const err = new Error("pin unavailable");
    expect(() =>
      handleExecutionTargetRoutingError(err, { hasExplicitPin: true, credentialKind: "company_api_key" }),
    ).toThrow(err);
  });
});

describe("resolveHeartbeatExecutionTargetOrganizationId", () => {
  it("threads the company's real organization into execution-target routing", async () => {
    await expect(
      resolveHeartbeatExecutionTargetOrganizationId(companyOrgDb("org-1"), {
        companyId: "company-1",
        tenantIsolationEnforced: true,
      }),
    ).resolves.toBe("org-1");
  });

  it("fails closed when cloud routing cannot resolve the company organization", async () => {
    await expect(
      resolveHeartbeatExecutionTargetOrganizationId(companyOrgDb(null), {
        companyId: "company-1",
        tenantIsolationEnforced: true,
      }),
    ).rejects.toThrow(/cannot resolve an organization/i);
  });

  it("preserves the self-hosted null-org fallback", async () => {
    await expect(
      resolveHeartbeatExecutionTargetOrganizationId(companyOrgDb(null), {
        companyId: "company-1",
        tenantIsolationEnforced: false,
      }),
    ).resolves.toBeNull();
  });
});
