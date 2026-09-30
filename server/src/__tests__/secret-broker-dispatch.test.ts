import { describe, expect, it } from "vitest";
import type { AuthorizedSecretResolution } from "@armyofagents/db";
import { secretHandleRefSchema } from "@armyofagents/worker-protocol";
import {
  dispatchResolvedSecret,
  failClosedSecretBrokers,
  type SecretBrokerSet,
} from "../services/secret-broker.js";

// -----------------------------------------------------------------------------
// DAT-004 — broker dispatch seam (post-fence, post-authorization). Proves the
// no-value-to-sandbox (#1), audit-only-metadata (#4), and no-plaintext-on-wire (#3)
// invariants structurally, without a database.
// -----------------------------------------------------------------------------

const SECRET_MARKER = "SECRET-VALUE-should-never-hit-wire-or-sandbox";
const RUN_JWT_MARKER = "MINTED-RUN-JWT-should-never-hit-wire";

function authorized(overrides: Partial<AuthorizedSecretResolution> = {}): AuthorizedSecretResolution {
  return {
    handleId: "handle-1",
    refKind: "company_secret",
    refId: "company-secret-1",
    materialization: "env",
    usePolicy: "sandbox_local_only",
    destination: null,
    ownerPrincipalKind: null,
    ownerPrincipalId: null,
    boundTargetGeneration: null,
    companyId: "company-1",
    resolveCount: 1,
    ...overrides,
  };
}

function recordingBrokers(): SecretBrokerSet & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolveConnectorOAuth(input) {
      calls.push(`oauth:${input.companyId}:${input.refId}`);
      return SECRET_MARKER;
    },
    async resolveProviderOrCompanySecret(input) {
      calls.push(`secret:${input.refKind}:${input.companyId}:${input.refId}`);
      return SECRET_MARKER;
    },
    async resolveRunJwt(input) {
      calls.push(`runjwt:${input.companyId}:${input.refId}:${input.ownerPrincipalId}`);
      return RUN_JWT_MARKER;
    },
  };
}

describe("DAT-004 dispatchResolvedSecret", () => {
  it("resolves a connector_oauth handle to the fence_proxy seam via the OAuth broker", async () => {
    const brokers = recordingBrokers();
    const out = await dispatchResolvedSecret(authorized({
      refKind: "connector_oauth", refId: "mcp:oauth:notion", materialization: "proxy",
      usePolicy: "fence_proxy", destination: "https://api.notion.com",
    }), brokers);
    expect(out.outcome).toBe("resolved");
    if (out.outcome !== "resolved") return;
    expect(out.seam).toBe("fence_proxy");
    expect(out.material.value).toBe(SECRET_MARKER);
    expect(out.material.destination).toBe("https://api.notion.com");
    expect(brokers.calls).toEqual(["oauth:company-1:mcp:oauth:notion"]);
  });

  it("resolves provider_key / company_secret via the secret broker", async () => {
    const brokers = recordingBrokers();
    const prov = await dispatchResolvedSecret(authorized({
      refKind: "provider_key", refId: "provider:anthropic", materialization: "file",
      usePolicy: "remote_server_fenced", destination: "https://api.anthropic.com",
    }), brokers);
    expect(prov.outcome).toBe("resolved");
    if (prov.outcome !== "resolved") return;
    expect(prov.seam).toBe("remote_server_fenced");
    expect(brokers.calls).toEqual(["secret:provider_key:company-1:provider:anthropic"]);
  });

  it("returns a device_local HANDOFF DESCRIPTOR with NO value, without touching any broker", async () => {
    const brokers = recordingBrokers();
    const out = await dispatchResolvedSecret(authorized({
      refKind: "device_local", refId: "provider-credential-1", materialization: "file",
      usePolicy: "sandbox_local_only", ownerPrincipalKind: "user", ownerPrincipalId: "u1",
    }), brokers);
    expect(out.outcome).toBe("device_handoff");
    if (out.outcome !== "device_handoff") return;
    // No broker was invoked — the value never leaves the OS keystore.
    expect(brokers.calls).toEqual([]);
    // Structural no-value proof: the handoff descriptor carries NO secret bytes anywhere.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(SECRET_MARKER);
    expect(Object.keys(out.handoff)).not.toContain("value");
    expect(out.handoff.refId).toBe("provider-credential-1");
    expect(out.handoff.ownerPrincipalId).toBe("u1");
  });

  it("no-value-to-sandbox: a network-use handle delivers its value ONLY to a network seam", async () => {
    const brokers = recordingBrokers();
    const out = await dispatchResolvedSecret(authorized({
      refKind: "connector_oauth", refId: "mcp:oauth:x", materialization: "proxy",
      usePolicy: "fence_proxy", destination: "https://api.x",
    }), brokers);
    // The only value-bearing outcome is `resolved`, and its seam is a network seam
    // (fence_proxy/remote_server_fenced) — never a plain sandbox delivery of a
    // network-use handle.
    expect(out.outcome).toBe("resolved");
    if (out.outcome !== "resolved") return;
    expect(["fence_proxy", "remote_server_fenced"]).toContain(out.seam);
  });

  it("no-plaintext-on-wire: the resolved material is NOT a valid frozen SecretHandleRef", async () => {
    const brokers = recordingBrokers();
    const out = await dispatchResolvedSecret(authorized({
      refKind: "connector_oauth", refId: "mcp:oauth:x", materialization: "proxy",
      usePolicy: "fence_proxy", destination: "https://api.x",
    }), brokers);
    if (out.outcome !== "resolved") throw new Error("expected resolved");
    // The frozen wire ref is `.strict()` and forbids any token/value key — a resolved
    // material can never be serialized as a SecretHandleRef.
    expect(secretHandleRefSchema.safeParse(out.material).success).toBe(false);
    expect(secretHandleRefSchema.safeParse({
      handleId: "11111111-1111-4111-8111-111111111111",
      materialization: { kind: "proxy" },
      usePolicy: "fence_proxy",
      value: out.material.value,
    }).success).toBe(false);
  });

  it("fail-closed default brokers never yield a value for a network handle", async () => {
    await expect(dispatchResolvedSecret(authorized({
      refKind: "connector_oauth", refId: "mcp:oauth:x", materialization: "proxy",
      usePolicy: "fence_proxy", destination: "https://api.x",
    }), failClosedSecretBrokers)).rejects.toThrow();
  });

  it("resolves a run_jwt handle to the sandbox_local_only env seam via the run_jwt broker", async () => {
    const brokers = recordingBrokers();
    const out = await dispatchResolvedSecret(authorized({
      refKind: "run_jwt", refId: "job-uuid-1", materialization: "env",
      usePolicy: "sandbox_local_only", materializationTarget: "AOA_API_KEY", destination: null,
      ownerPrincipalKind: "worker", ownerPrincipalId: "agent-1",
    }), brokers);
    expect(out.outcome).toBe("resolved");
    if (out.outcome !== "resolved") return;
    expect(out.seam).toBe("sandbox_local_only");
    expect(out.material.value).toBe(RUN_JWT_MARKER);
    expect(out.material.materializationTarget).toBe("AOA_API_KEY");
    expect(out.material.destination).toBeNull();
    // ONLY the run_jwt broker is invoked — never the connector/secret stores — and it
    // receives the company (fence-derived), the jobId (refId) and the handle owner.
    expect(brokers.calls).toEqual(["runjwt:company-1:job-uuid-1:agent-1"]);
  });

  it("fail-closed default brokers never yield a value for a run_jwt handle", async () => {
    await expect(dispatchResolvedSecret(authorized({
      refKind: "run_jwt", refId: "job-uuid-1", materialization: "env",
      usePolicy: "sandbox_local_only", materializationTarget: "AOA_API_KEY",
    }), failClosedSecretBrokers)).rejects.toThrow();
  });
});

describe("DSK-001 Lane B/B2 — the handoff key set is FROZEN, and carries its scope", () => {
  // The old proof was `expect(Object.keys(handoff)).not.toContain("value")`. That is
  // a denylist of one: a field named `token`, `bytes`, `secret` or `material` would
  // have passed it untouched. Design invariant I19 asks for the opposite shape — an
  // allowlist — so a NEW field cannot appear without this test being edited on
  // purpose. A reviewer editing this list is the point.

  const FROZEN_HANDOFF_KEYS = [
    "boundTargetGeneration",
    "companyId",
    "destination",
    "handleId",
    "materialization",
    "ownerPrincipalId",
    "ownerPrincipalKind",
    "refId",
    "refKind",
    "usePolicy",
  ];

  async function handoff() {
    const out = await dispatchResolvedSecret(authorized({
      refKind: "device_local", refId: "b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e",
      materialization: "proxy", usePolicy: "fence_proxy",
      destination: "https://api.provider.example",
      ownerPrincipalKind: "user", ownerPrincipalId: "u1",
    }), recordingBrokers());
    if (out.outcome !== "device_handoff") throw new Error(`expected a handoff, got ${out.outcome}`);
    return out.handoff;
  }

  it("has EXACTLY the frozen key set — no more, no fewer", async () => {
    expect(Object.keys(await handoff()).sort()).toEqual(FROZEN_HANDOFF_KEYS);
  });

  it("carries the company scope, so a consumer need not re-derive it from the wire", async () => {
    // companyId comes from the LOCKED lease (AuthorizedSecretResolution.companyId),
    // never from a request. A device-side consumer that had to re-derive it would be
    // trusting the wire for the one fact the fence exists to pin.
    const h = await handoff();
    expect(h.companyId).toBe("company-1");
  });

  it("carries handleId and boundTargetGeneration, so an activation can be bound and revoked", async () => {
    const h = await handoff();
    expect(h.handleId).toBeTruthy();
    expect(h).toHaveProperty("boundTargetGeneration");
  });

  it("carries destination — load-bearing on exactly the fence_proxy seam", async () => {
    // C-7. Rule 4b guarantees destination is non-null for a network-use handle, and
    // fence_proxy is the seam D10's `proxy_endpoint` arm exists to serve. Dropping it
    // would force DSK-002 to widen this type immediately.
    expect((await handoff()).destination).toBe("https://api.provider.example");
  });

  it("STILL carries no value-bearing field under any name", async () => {
    const h = await handoff();
    for (const key of Object.keys(h)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      // NOT "material": `materialization` legitimately contains it, and a check that
      // forces you to rename a correct field is a bad check. `value` covers the case
      // that mattered (`FenceResolvedMaterial.value`).
      for (const forbidden of ["value", "token", "secret", "credential", "bytes", "password", "apikey"]) {
        expect(normalized, `handoff field "${key}"`).not.toContain(forbidden);
      }
    }
  });
});
