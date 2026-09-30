import { describe, expect, it, vi } from "vitest";

import { secretHandleRefSchema, type SecretHandleRef } from "@armyofagents/worker-protocol";

import { generateDeviceKey } from "../identity/device-key.js";
import type { WorkerSession } from "../enrollment/enroll.js";
import {
  EXECUTION_SECRET_RESOLVE_PATH,
  ControlPlaneTransportError,
  type ControlPlaneClient,
  type WorkerOperationHttpRequest,
  type WorkerOperationHttpResponse,
} from "../transport/client.js";
import {
  PROVIDER_AUTH_ENV_TARGETS,
  SecretMaterializationError,
  UnknownSecretTargetError,
  classifyResolveResponse,
  createRedeemer,
  synthesiseRunSecrets,
  type RedeemFn,
  type RunFenceContext,
} from "../lease/secret-redemption.js";

const HANDLE_A = "11111111-1111-4111-8111-111111111111";
const HANDLE_B = "22222222-2222-4222-8222-222222222222";

function envHandle(handleId: string, target = "ANTHROPIC_API_KEY"): SecretHandleRef {
  return secretHandleRefSchema.parse({
    handleId,
    materialization: { kind: "env", target },
    usePolicy: "sandbox_local_only",
  });
}

function proxyHandle(handleId: string): SecretHandleRef {
  return secretHandleRefSchema.parse({
    handleId,
    materialization: { kind: "proxy" },
    usePolicy: "fence_proxy",
  });
}

describe("classifyResolveResponse — the 200-for-denial gotcha (A5)", () => {
  it("a 200 resolved with a non-empty value classifies resolved", () => {
    const c = classifyResolveResponse({
      status: 200,
      body: { protocolVersion: 1, outcome: "resolved", envTarget: "ANTHROPIC_API_KEY", value: "sk-live-abc" },
    });
    expect(c).toEqual({ kind: "resolved", envTarget: "ANTHROPIC_API_KEY", value: "sk-live-abc" });
  });

  it("a 200 DENIED is NOT resolved — it must classify denied, never success", () => {
    const c = classifyResolveResponse({ status: 200, body: { protocolVersion: 1, outcome: "denied", reason: "stale_fence" } });
    expect(c.kind).toBe("denied");
    if (c.kind === "denied") expect(c.reason).toBe("stale_fence");
  });

  it("a 200 resolved with an EMPTY value is NOT resolved (anti-vacuity)", () => {
    const c = classifyResolveResponse({ status: 200, body: { protocolVersion: 1, outcome: "resolved", envTarget: "ANTHROPIC_API_KEY", value: "" } });
    expect(c.kind).not.toBe("resolved");
  });

  it("a 200 resolved with an EMPTY envTarget is NOT resolved", () => {
    const c = classifyResolveResponse({ status: 200, body: { protocolVersion: 1, outcome: "resolved", envTarget: "", value: "sk-live" } });
    expect(c.kind).not.toBe("resolved");
  });

  it("a non-200 status classifies malformed (fail closed), never resolved", () => {
    const c = classifyResolveResponse({ status: 500, body: null });
    expect(c.kind).toBe("malformed");
  });

  it("an unparseable / shapeless body classifies malformed", () => {
    expect(classifyResolveResponse({ status: 200, body: null }).kind).toBe("malformed");
    expect(classifyResolveResponse({ status: 200, body: { outcome: "weird" } }).kind).toBe("malformed");
  });
});

describe("PROVIDER_AUTH_ENV_TARGETS — the worker-local allowlist", () => {
  it("admits the CLI-001 v1 provider-auth names only", () => {
    expect(PROVIDER_AUTH_ENV_TARGETS.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(PROVIDER_AUTH_ENV_TARGETS.has("OPENAI_API_KEY")).toBe(true);
    expect(PROVIDER_AUTH_ENV_TARGETS.has("AOA_API_KEY")).toBe(true);
    expect(PROVIDER_AUTH_ENV_TARGETS.has("PATH")).toBe(false);
    expect(PROVIDER_AUTH_ENV_TARGETS.has("LD_PRELOAD")).toBe(false);
  });
});

describe("synthesiseRunSecrets — env synthesis, allowlist, fail-closed", () => {
  const ok: RedeemFn = async () => ({ kind: "resolved", envTarget: "ANTHROPIC_API_KEY", value: "sk-live-abc" });

  it("no handles → empty env and no canaries", async () => {
    const out = await synthesiseRunSecrets([], ok);
    expect(out.env).toEqual({});
    expect(out.canaries).toEqual([]);
  });

  it("a valid env handle → env carries exactly the target, value is a canary", async () => {
    const out = await synthesiseRunSecrets([envHandle(HANDLE_A)], ok);
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: "sk-live-abc" });
    expect(out.canaries).toEqual(["sk-live-abc"]);
  });

  it("an UNKNOWN target fails the run (never dropped) — before any redeem (A4)", async () => {
    const redeem = vi.fn(ok);
    await expect(synthesiseRunSecrets([envHandle(HANDLE_A, "PATH")], redeem)).rejects.toBeInstanceOf(
      UnknownSecretTargetError,
    );
    expect(redeem).not.toHaveBeenCalled(); // fail fast, no audit increment
  });

  it("a response envTarget that DISAGREES with the handle target fails closed", async () => {
    const mismatched: RedeemFn = async () => ({ kind: "resolved", envTarget: "OPENAI_API_KEY", value: "sk" });
    await expect(synthesiseRunSecrets([envHandle(HANDLE_A, "ANTHROPIC_API_KEY")], mismatched)).rejects.toBeInstanceOf(
      SecretMaterializationError,
    );
  });

  it("a DENIED redemption fails the run closed (A2)", async () => {
    const denied: RedeemFn = async () => ({ kind: "denied", reason: "target_revoked" });
    await expect(synthesiseRunSecrets([envHandle(HANDLE_A)], denied)).rejects.toBeInstanceOf(SecretMaterializationError);
  });

  it("a TRANSPORT failure fails the run closed", async () => {
    const t: RedeemFn = async () => ({ kind: "transport" });
    await expect(synthesiseRunSecrets([envHandle(HANDLE_A)], t)).rejects.toBeInstanceOf(SecretMaterializationError);
  });

  it("a non-env / non-sandbox_local_only handle is SKIPPED, not redeemed (out of scope)", async () => {
    const redeem = vi.fn(ok);
    const out = await synthesiseRunSecrets([proxyHandle(HANDLE_A)], redeem);
    expect(out.env).toEqual({});
    expect(out.canaries).toEqual([]);
    expect(redeem).not.toHaveBeenCalled();
  });

  it("two env handles both redeem, each exactly once (A10 shape)", async () => {
    const seen: string[] = [];
    const redeem: RedeemFn = async (id) => {
      seen.push(id);
      return { kind: "resolved", envTarget: "ANTHROPIC_API_KEY", value: `v-${id}` };
    };
    const out = await synthesiseRunSecrets([envHandle(HANDLE_A), envHandle(HANDLE_B)], redeem);
    expect(seen).toEqual([HANDLE_A, HANDLE_B]);
    expect(out.canaries).toEqual([`v-${HANDLE_A}`, `v-${HANDLE_B}`]);
  });
});

// -----------------------------------------------------------------------------
// DEP-011 Slice 2a — the owned-labels-capability threading (classify + synthesise).
// -----------------------------------------------------------------------------

const CAP_LABELS = {
  organizationId: "org-1",
  targetId: "tgt-1",
  workerId: "wkr-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  deviceGeneration: 7,
} as const;

function capLike(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, audience: "adapter-manager", ownedLabels: { ...CAP_LABELS }, expiresAt: 2_000_000, sig: "sig-a", ...overrides };
}

describe("classifyResolveResponse — DEP-011 owned-labels-capability threading", () => {
  it("a resolved reply carrying a VALID capability threads it onto the classification", () => {
    const cap = capLike();
    const c = classifyResolveResponse({
      status: 200,
      body: { protocolVersion: 1, outcome: "resolved", envTarget: "ANTHROPIC_API_KEY", value: "sk-live", ownedLabelsCapability: cap },
    });
    expect(c.kind).toBe("resolved");
    if (c.kind === "resolved") expect(c.ownedLabelsCapability).toEqual(cap);
  });

  it("a resolved reply with NO capability stays resolved WITHOUT one (byte-identical desktop)", () => {
    const c = classifyResolveResponse({
      status: 200,
      body: { protocolVersion: 1, outcome: "resolved", envTarget: "ANTHROPIC_API_KEY", value: "sk-live" },
    });
    expect(c.kind).toBe("resolved");
    if (c.kind === "resolved") expect(c.ownedLabelsCapability).toBeUndefined();
  });

  it("a resolved reply with a MALFORMED capability is still resolved, cap treated as ABSENT (junk never carried)", () => {
    const c = classifyResolveResponse({
      status: 200,
      body: { protocolVersion: 1, outcome: "resolved", envTarget: "ANTHROPIC_API_KEY", value: "sk-live", ownedLabelsCapability: { v: "1", sig: 1 } },
    });
    expect(c.kind).toBe("resolved");
    if (c.kind === "resolved") expect(c.ownedLabelsCapability).toBeUndefined();
  });
});

describe("synthesiseRunSecrets — DEP-011 capability dedup + fail-closed", () => {
  function resolvedWithCap(cap?: Record<string, unknown>): RedeemFn {
    return async () => ({ kind: "resolved", envTarget: "ANTHROPIC_API_KEY", value: "sk-live", ownedLabelsCapability: cap } as never);
  }

  it("all-absent (no capability on any handle) → capability is undefined (desktop no-op)", async () => {
    const out = await synthesiseRunSecrets([envHandle(HANDLE_A)], resolvedWithCap(undefined));
    expect(out.capability).toBeUndefined();
  });

  it("a single capability is threaded through", async () => {
    const cap = capLike();
    const out = await synthesiseRunSecrets([envHandle(HANDLE_A)], resolvedWithCap(cap));
    expect(out.capability).toEqual(cap);
  });

  it("two handles, SAME ownedLabels/v/audience but differing expiresAt/sig → dedup to ONE (keeps a non-expired), never fail-closed", async () => {
    const caps = [capLike({ expiresAt: 2_000_000, sig: "sig-a" }), capLike({ expiresAt: 2_000_050, sig: "sig-b" })];
    let n = 0;
    const redeem: RedeemFn = async () => ({ kind: "resolved", envTarget: "ANTHROPIC_API_KEY", value: `v-${n}`, ownedLabelsCapability: caps[n++] } as never);
    const out = await synthesiseRunSecrets([envHandle(HANDLE_A), envHandle(HANDLE_B)], redeem);
    expect(out.capability).toBeDefined();
    // the ms-delta on expiresAt/sig must NOT fail the run closed (review MED-3)
    expect(out.capability!.ownedLabels).toEqual(CAP_LABELS);
  });

  it("two handles with DIVERGENT ownedLabels tuples → FAIL CLOSED (throws)", async () => {
    const caps = [capLike(), capLike({ ownedLabels: { ...CAP_LABELS, jobId: "job-OTHER" } })];
    let n = 0;
    const redeem: RedeemFn = async () => ({ kind: "resolved", envTarget: "ANTHROPIC_API_KEY", value: `v-${n}`, ownedLabelsCapability: caps[n++] } as never);
    await expect(synthesiseRunSecrets([envHandle(HANDLE_A), envHandle(HANDLE_B)], redeem)).rejects.toBeInstanceOf(
      SecretMaterializationError,
    );
  });
});

const SESSION: WorkerSession = {
  token: "live-session-token",
  workerId: "11111111-1111-4111-8111-111111111111",
  targetId: "22222222-2222-4222-8222-222222222222",
  deviceGeneration: 3,
  obtainedAtMs: 1_000,
  ttlMs: 900_000,
  expiresAtMs: 901_000,
};

const FENCE: RunFenceContext = {
  workerId: SESSION.workerId,
  jobId: "33333333-3333-4333-8333-333333333333",
  attempt: 1,
  leaseId: "44444444-4444-4444-8444-444444444444",
  fenceToken: "fence-abc",
};

function fakeRedeemClient(
  respond: (req: WorkerOperationHttpRequest, call: number) => WorkerOperationHttpResponse | Promise<WorkerOperationHttpResponse> | never,
) {
  const calls: WorkerOperationHttpRequest[] = [];
  const client = {
    executionSecretResolvePath: EXECUTION_SECRET_RESOLVE_PATH,
    resolveExecutionSecret: vi.fn(async (req: WorkerOperationHttpRequest) => {
      const n = calls.length;
      calls.push(req);
      return respond(req, n);
    }),
  } as unknown as ControlPlaneClient;
  return { client, calls };
}

describe("createRedeemer — client round-trip + bounded retry (R7)", () => {
  it("POSITIVE CONTROL: a non-transport throw propagates (never swallowed to a silent success)", async () => {
    const { client } = fakeRedeemClient(() => {
      throw new Error("device proof signing exploded");
    });
    const redeem = createRedeemer({ client, key: generateDeviceKey(), session: SESSION, fence: FENCE });
    await expect(redeem(HANDLE_A)).rejects.toThrow("device proof signing exploded");
  });

  it("a 200 resolved → resolved, exactly ONE call (A10)", async () => {
    const { client, calls } = fakeRedeemClient(() => ({
      status: 200,
      body: { protocolVersion: 1, outcome: "resolved", envTarget: "ANTHROPIC_API_KEY", value: "sk-live" },
    }));
    const redeem = createRedeemer({ client, key: generateDeviceKey(), session: SESSION, fence: FENCE });
    const c = await redeem(HANDLE_A);
    expect(c).toEqual({ kind: "resolved", envTarget: "ANTHROPIC_API_KEY", value: "sk-live" });
    expect(calls).toHaveLength(1);
  });

  it("a DENIED (200) is NEVER retried — exactly ONE call (A11)", async () => {
    const { client, calls } = fakeRedeemClient(() => ({
      status: 200,
      body: { protocolVersion: 1, outcome: "denied", reason: "stale_fence" },
    }));
    const redeem = createRedeemer({ client, key: generateDeviceKey(), session: SESSION, fence: FENCE });
    const c = await redeem(HANDLE_A);
    expect(c.kind).toBe("denied");
    expect(calls).toHaveLength(1);
  });

  it("a TRANSPORT error is retried ONCE, then a success is taken — exactly TWO calls (A11)", async () => {
    const { client, calls } = fakeRedeemClient((_req, n) => {
      if (n === 0) throw new ControlPlaneTransportError("timeout", "boom");
      return { status: 200, body: { protocolVersion: 1, outcome: "resolved", envTarget: "ANTHROPIC_API_KEY", value: "sk-live" } };
    });
    const redeem = createRedeemer({ client, key: generateDeviceKey(), session: SESSION, fence: FENCE });
    const c = await redeem(HANDLE_A);
    expect(c.kind).toBe("resolved");
    expect(calls).toHaveLength(2);
  });

  it("a SECOND transport error is terminal — transport, exactly TWO calls (no unbounded retry)", async () => {
    const { client, calls } = fakeRedeemClient(() => {
      throw new ControlPlaneTransportError("network", "boom");
    });
    const redeem = createRedeemer({ client, key: generateDeviceKey(), session: SESSION, fence: FENCE });
    const c = await redeem(HANDLE_A);
    expect(c.kind).toBe("transport");
    expect(calls).toHaveLength(2);
  });

  it("signs the device proof over the resolve path (the value returns in the body)", async () => {
    const { client, calls } = fakeRedeemClient(() => ({
      status: 200,
      body: { protocolVersion: 1, outcome: "resolved", envTarget: "ANTHROPIC_API_KEY", value: "sk-live" },
    }));
    const redeem = createRedeemer({ client, key: generateDeviceKey(), session: SESSION, fence: FENCE });
    await redeem(HANDLE_A);
    const req = calls[0];
    expect(req.sessionToken).toBe("live-session-token");
    expect(Object.keys(req.proofHeaders).length).toBeGreaterThan(0);
    // the body echoes the run fence + handle
    const body = JSON.parse(req.bytes.toString("utf8"));
    expect(body).toMatchObject({ audience: "worker_run", jobId: FENCE.jobId, leaseId: FENCE.leaseId, handleId: HANDLE_A });
    // ★ EXACT key set — the server schema is `.strict()`, so an EXTRA field would make every resolve
    // 400 (→ denyMalformed) while a `toMatchObject` unit test stayed green. Pin the field set.
    expect(Object.keys(body).sort()).toEqual(
      ["attempt", "audience", "correlationId", "fenceToken", "handleId", "jobId", "leaseId", "protocolVersion", "workerId"],
    );
  });
});
