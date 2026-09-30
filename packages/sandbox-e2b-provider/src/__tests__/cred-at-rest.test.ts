// DEP-012 Slice 4+5 (P4/Cred-1) — the tenant model-provider key must NEVER sit at rest in
// durable E2B metadata (Decision #104: the credential must not hit a durable store).
//
// A real E2B transport persists `metadata` in E2B cloud (returned by Sandbox.list()/
// getInfo()); the previous `[METADATA_KEYS.env]: JSON.stringify(spec.env)` write left the
// key AT REST in a shared-account durable store. This proves `create` sends NO auth value
// in `metadata`, while the necessary `envVars` channel (the sandbox needs the env to run)
// still carries it — and the mock's create-fault contract still works off `envVars`.

import { describe, expect, it } from "vitest";

import type { ResourceLabels } from "@armyofagents/worker-daemon";

import { E2bSandboxProvider } from "../e2b-provider.js";
import { MockE2bTransport } from "../mock-transport.js";
import { METADATA_KEYS, DIRECTIVE_KEYS } from "../directives.js";
import type { E2bCreateRequest } from "../transport.js";

const LABELS: ResourceLabels = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  targetId: "22222222-2222-4222-8222-222222222222",
  workerId: "33333333-3333-4333-8333-333333333333",
  jobId: "44444444-4444-4444-8444-444444444444",
  attempt: 1,
  leaseId: "55555555-5555-4555-8555-555555555555",
  deviceGeneration: 1,
};

const PLANTED = "sk-PLANTED-PROVIDER-SECRET-do-not-persist";

function captureCreate(mock: MockE2bTransport): { requests: E2bCreateRequest[] } {
  const requests: E2bCreateRequest[] = [];
  const original = mock.create.bind(mock);
  mock.create = async (req: E2bCreateRequest) => {
    requests.push(req);
    return original(req);
  };
  return { requests };
}

describe("DEP-012 Cred-1 — no provider-auth value at rest in E2B metadata", () => {
  it("create sends NO auth value in durable metadata; envVars still carries it", async () => {
    const mock = new MockE2bTransport();
    const captured = captureCreate(mock);
    const provider = new E2bSandboxProvider({ transport: mock });

    await provider.create(
      {
        resourceLabels: LABELS,
        command: "codex run",
        args: [],
        env: { ANTHROPIC_API_KEY: PLANTED, HARMLESS: "value" },
        workloadType: "batch",
      },
      { deadlineMs: Date.now() + 60_000, idempotencyKey: "idem-1" },
    );

    expect(captured.requests).toHaveLength(1);
    const req = captured.requests[0]!;

    // ★ The durable metadata carries NO env key and NO trace of the planted secret.
    expect(req.metadata[METADATA_KEYS.env]).toBeUndefined();
    expect(JSON.stringify(req.metadata)).not.toContain(PLANTED);
    // Labels/command/workload are still round-tripped (the non-sensitive management record).
    expect(req.metadata[METADATA_KEYS.command]).toBe("codex run");
    expect(req.metadata[METADATA_KEYS.labels]).toContain(LABELS.organizationId);

    // The necessary channel: E2B needs the env to run the sandbox — envVars carries it.
    expect(req.envVars.ANTHROPIC_API_KEY).toBe(PLANTED);
    expect(req.envVars.HARMLESS).toBe("value");
  });

  it("the mock's create-fault directives still decode (now off envVars, not metadata)", async () => {
    const mock = new MockE2bTransport();
    const provider = new E2bSandboxProvider({ transport: mock });

    // destroyFailures fault delivered via spec.env (→ envVars). The mock must still see it.
    const created = await provider.create(
      {
        resourceLabels: LABELS,
        command: "codex run",
        args: [],
        env: { [DIRECTIVE_KEYS.destroyFailures]: "1" },
        workloadType: "batch",
      },
      { deadlineMs: Date.now() + 60_000, idempotencyKey: "idem-2" },
    );

    // First destroy hits the injected failure (fault decoded from envVars), then converges.
    const first = await provider.destroy(created.sandboxId, { deadlineMs: Date.now() + 1000, idempotencyKey: "d1" });
    expect(first.cleanupStatus).toBe("failed");
    const second = await provider.destroy(created.sandboxId, { deadlineMs: Date.now() + 1000, idempotencyKey: "d2" });
    expect(second.cleanupStatus).toBe("success");
  });
});
