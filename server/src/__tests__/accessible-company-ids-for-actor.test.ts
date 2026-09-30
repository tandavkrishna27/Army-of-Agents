/**
 * Unit test for `accessibleCompanyIdsForActor` (routes/authz.ts) — the actor
 * derivation that scopes bare-identifier ambiguity resolution to the companies
 * an actor can reach.
 *
 * `undefined` = all-access sentinel (self-hosted loopback / self-hosted
 * instance-admin) → the caller keeps the unfiltered reject-ambiguous resolve.
 * `[]` = the actor can access nothing → the caller returns null (404).
 *
 * The derivation mirrors `assertCompanyAccess`'s allow rules; the cloud
 * instance-admin bypass is intentionally NOT mirrored (isInstanceAdmin is
 * clamped false in cloud_auth by the auth middleware, so it never reaches the
 * board branch there anyway).
 */
import { afterEach, describe, expect, it } from "vitest";
import { accessibleCompanyIdsForActor } from "../routes/authz.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

afterEach(() => {
  // Reset to the module default so cross-test leakage can't flip enforcement.
  setDeploymentMode("local_trusted");
});

describe("accessibleCompanyIdsForActor", () => {
  it("agent actor → [companyId]", () => {
    const actor = { type: "agent", source: "agent_key", companyId: "c1" } as Actor;
    expect(accessibleCompanyIdsForActor(actor)).toEqual(["c1"]);
  });

  it("agent actor without companyId → []", () => {
    const actor = { type: "agent", source: "agent_key" } as Actor;
    expect(accessibleCompanyIdsForActor(actor)).toEqual([]);
  });

  it("self-hosted mcp actor → embedded [companyId]", () => {
    const actor = { type: "mcp", source: "mcp_key", companyId: "c1" } as Actor;
    expect(accessibleCompanyIdsForActor(actor)).toEqual(["c1"]);
  });

  it("cloud mcp actor → auth middleware's live company scope", () => {
    setDeploymentMode("cloud_auth");
    const actor = {
      type: "mcp",
      source: "mcp_key",
      companyId: "c1",
      companyIds: ["c1"],
    } as Actor;
    expect(accessibleCompanyIdsForActor(actor)).toEqual(["c1"]);
  });

  it("cloud mcp actor without a live scope → []", () => {
    setDeploymentMode("cloud_auth");
    const actor = { type: "mcp", source: "mcp_key", companyId: "c1" } as Actor;
    expect(accessibleCompanyIdsForActor(actor)).toEqual([]);
  });

  it("board loopback (local_implicit) → undefined (all-access)", () => {
    const actor = { type: "board", source: "local_implicit" } as Actor;
    expect(accessibleCompanyIdsForActor(actor)).toBeUndefined();
  });

  it("board self-hosted instance-admin (local_trusted) → undefined (all-access)", () => {
    setDeploymentMode("local_trusted");
    const actor = {
      type: "board",
      source: "session",
      isInstanceAdmin: true,
    } as Actor;
    expect(accessibleCompanyIdsForActor(actor)).toBeUndefined();
  });

  it("board cloud (cloud_auth, not admin) → companyIds", () => {
    setDeploymentMode("cloud_auth");
    const actor = {
      type: "board",
      source: "session",
      companyIds: ["c1", "c2"],
      isInstanceAdmin: false,
    } as Actor;
    expect(accessibleCompanyIdsForActor(actor)).toEqual(["c1", "c2"]);
  });

  it("board cloud with companyIds undefined → []", () => {
    setDeploymentMode("cloud_auth");
    const actor = { type: "board", source: "session" } as Actor;
    expect(accessibleCompanyIdsForActor(actor)).toEqual([]);
  });

  it("undefined actor → []", () => {
    expect(accessibleCompanyIdsForActor(undefined)).toEqual([]);
  });
});
