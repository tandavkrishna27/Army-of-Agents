// server/src/__tests__/execution-target-resolver.test.ts
import { describe, expect, it } from "vitest";
import {
  chooseExecutionTargetRow,
  executionTargetToAdapterConfig,
} from "../services/execution-target-resolver.js";

describe("executionTargetToAdapterConfig hardening (P5 review gap #1, deployment-mode-aware)", () => {
  const weakenedTenant = {
    id: "t", slug: "s", kind: "dedicated_worker", trustClass: "dedicated_tenant", status: "active",
    organizationId: "org-1",
    config: { image: "x", network: "bridge", allowHostGateway: true, isolation: { capDropAll: false, readOnlyRootfs: false, noNewPrivileges: false } },
  };

  it("MULTI_TENANT + TENANT target: remains registry-only until the worker plane is validated", () => {
    expect(() => executionTargetToAdapterConfig(weakenedTenant, /* multiTenant */ true))
      .toThrow(/registry-only.*Gate-B/i);
  });

  it("MULTI_TENANT + OPERATOR target: also remains inert before Gate-B", () => {
    expect(() => executionTargetToAdapterConfig({
      id: "t", slug: "pool", kind: "pooled_gvisor", trustClass: "shared_multitenant", status: "active",
      organizationId: null,
      config: { network: "bridge", allowHostGateway: true },
    }, /* multiTenant */ true)).toThrow(/registry-only.*Gate-B/i);
  });

  it("SELF-HOSTED: honors allowHostGateway:true + custom network + custom (weaker) isolation from the trusted config", () => {
    const cfg = executionTargetToAdapterConfig(weakenedTenant, /* multiTenant */ false) as Record<string, unknown>;
    expect(cfg.allowHostGateway).toBe(true); // founder owns the box: local MCP bridge honored
    expect(cfg.network).toBe("bridge"); // custom network honored (no egress regression)
    const iso = cfg.isolation as Record<string, unknown>;
    expect(iso.capDropAll).toBe(false); // config honored exactly on self-hosted
    expect(iso.readOnlyRootfs).toBe(false);
    expect(iso.noNewPrivileges).toBe(false);
  });

  it("SELF-HOSTED: falls back to the hardened isolation baseline + network none when the trusted config omits them", () => {
    const cfg = executionTargetToAdapterConfig({
      id: "t", slug: "cp-worker", kind: "dedicated_worker", trustClass: "dedicated_tenant", status: "active",
      organizationId: "org-1", config: { image: "y" },
    }, /* multiTenant */ false) as Record<string, unknown>;
    expect(cfg.allowHostGateway).toBe(false); // not requested -> stays off
    expect(cfg.network).toBe("none"); // default egress
    expect((cfg.isolation as Record<string, unknown>).capDropAll).toBe(true); // default hardened baseline
  });

  it("local_host target yields no override (local driver) regardless of deployment mode", () => {
    expect(
      executionTargetToAdapterConfig({ id: "t", slug: "cp", kind: "local_host", trustClass: "local_trusted", status: "active", organizationId: null }, true),
    ).toBeNull();
    expect(
      executionTargetToAdapterConfig({ id: "t", slug: "cp", kind: "local_host", trustClass: "local_trusted", status: "active", organizationId: null }, false),
    ).toBeNull();
  });
});

const pooled = { id: "t-pool", slug: "pool-1", kind: "pooled_gvisor", trustClass: "shared_multitenant", status: "active", organizationId: null };
const dedicated = { id: "t-ded", slug: "hetzner-owner", kind: "dedicated_worker", trustClass: "dedicated_tenant", status: "active", organizationId: "org-1" };

// credentialKind + executionTargetSlug are P4's normalized seam fields (verbatim).
describe("chooseExecutionTargetRow (route by credential kind)", () => {
  it("business key routes to the org pooled_gvisor target", () => {
    const chosen = chooseExecutionTargetRow({ credentialKind: "company_api_key", pinnedTargetId: null, executionTargetSlug: null, targets: [pooled, dedicated] });
    expect(chosen.id).toBe("t-pool");
  });
  it("personal subscription routes to the dedicated target whose slug matches the credential", () => {
    const chosen = chooseExecutionTargetRow({ credentialKind: "personal_subscription", pinnedTargetId: null, executionTargetSlug: "hetzner-owner", targets: [pooled, dedicated] });
    expect(chosen.id).toBe("t-ded");
  });
  it("fails closed when a personal subscription's target does not match any dedicated target", () => {
    expect(() => chooseExecutionTargetRow({ credentialKind: "personal_subscription", pinnedTargetId: null, executionTargetSlug: "ghost", targets: [pooled, dedicated] })).toThrow(/target/i);
  });
  it("honors an explicit environment pin", () => {
    const chosen = chooseExecutionTargetRow({ credentialKind: "company_api_key", pinnedTargetId: "t-ded", executionTargetSlug: null, targets: [pooled, dedicated] });
    expect(chosen.id).toBe("t-ded");
  });
  it("returns null (fallback to local) when no targets exist", () => {
    const chosen = chooseExecutionTargetRow({ credentialKind: "company_api_key", pinnedTargetId: null, executionTargetSlug: null, targets: [] });
    expect(chosen).toBeNull();
  });
});
