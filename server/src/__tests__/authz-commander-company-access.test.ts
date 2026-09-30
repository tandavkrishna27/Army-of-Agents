import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertCompanyAccess } from "../routes/authz.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

function commanderReq(companyId: string) {
  return {
    actor: {
      type: "commander",
      source: "commander_jwt",
      companyId,
      userId: "u1",
      userRole: "founder",
      conversationId: "conv1",
      turnId: "run1",
    },
  } as never;
}

describe("assertCompanyAccess: commander branch (F1)", () => {
  beforeEach(() => setDeploymentMode("cloud_auth"));
  afterEach(() => setDeploymentMode("local_trusted"));

  it("ALLOWS a same-company commander actor in cloud_auth (no org/company membership arrays needed)", async () => {
    // The commander JWT sets ONLY companyId — before the branch this fell
    // through to the cloud board branch and 403'd. db is never queried on the
    // commander path, so a throwing db proves the branch returns before
    // resolveCompanyTenant.
    const throwingDb = {
      select: () => {
        throw new Error("db must not be queried for a commander actor");
      },
    } as never;
    await expect(
      assertCompanyAccess(throwingDb, commanderReq("c1"), "c1"),
    ).resolves.toBeUndefined();
  });

  it("REJECTS a cross-company commander actor (forbidden)", async () => {
    const throwingDb = {
      select: () => {
        throw new Error("unreachable");
      },
    } as never;
    await expect(
      assertCompanyAccess(throwingDb, commanderReq("A"), "B"),
    ).rejects.toThrow(/another company/);
  });
});
