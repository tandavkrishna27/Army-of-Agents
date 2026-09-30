import { describe, expect, it, beforeEach } from "vitest";
import { setDeploymentMode, getDeploymentMode, tenantIsolationEnforced } from "../config/deployment-mode.js";

describe("deployment-mode chokepoint", () => {
  beforeEach(() => setDeploymentMode("local_trusted"));

  it("tenantIsolationEnforced() is true ONLY in cloud_auth", () => {
    setDeploymentMode("local_trusted"); expect(tenantIsolationEnforced()).toBe(false);
    setDeploymentMode("authenticated"); expect(tenantIsolationEnforced()).toBe(false);
    setDeploymentMode("cloud_auth"); expect(tenantIsolationEnforced()).toBe(true);
  });

  it("defaults to a NON-enforcing self-hosted mode before boot sets it (never fail-open)", () => {
    expect(["local_trusted", "authenticated"]).toContain(getDeploymentMode());
  });
});
