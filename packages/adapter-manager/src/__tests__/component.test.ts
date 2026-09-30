// -----------------------------------------------------------------------------
// DEP-012 Slice 1 · Unit A — the driver <-> server COMPONENT integration test.
//
// Stands up the mock-backed adapter-manager server on a loopback port and drives it
// through the networked driver, exercising create + execute OVER THE WIRE (not the
// provider object directly — the novelty under test is the network hop: serialization,
// the idempotency replay, the zero-deadline short-circuit, and the error-vocab mapping).
//
// It hosts the REAL `E2bSandboxProvider` over the KEY-LESS `MockE2bTransport`, imported
// via SUBPATHS (never the barrel) so `real-transport` + the `e2b` SDK stay out of this
// test's module closure (S1.4 fence). This is single-tenant loopback with no deploy, no
// daemon, no mTLS — so the (deliberately) ungated `execute` route stands up no reachable
// oracle (S1.1/S1.4).
// -----------------------------------------------------------------------------

import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CreateResult,
  CreateSandboxSpec,
  ExecuteInput,
  ExecuteResult,
  ProviderOpContext,
} from "@armyofagents/worker-daemon";
import { NetworkedProviderDriver, WireProtocolError } from "@armyofagents/provider-wire";
import {
  SandboxEgressDeniedError,
  SandboxNotFoundError,
} from "@armyofagents/sandbox-e2b-provider/errors.js";
import { E2bSandboxProvider } from "@armyofagents/sandbox-e2b-provider/e2b-provider.js";
import { MockE2bTransport } from "@armyofagents/sandbox-e2b-provider/mock-transport.js";

import { createProviderServer } from "../server.js";

// The reserved execute egress directive (mock transport only) — kept in step with
// `directives.ts` DIRECTIVE_KEYS.egressClass. Folded into the execute env so the mock
// simulates a blocked egress the provider translates to SandboxEgressDeniedError.
const EGRESS_DIRECTIVE_KEY = "__aoa_egress_class";

let server: ReturnType<typeof createProviderServer>;
let baseUrl: string;

async function startServer(): Promise<void> {
  const provider = new E2bSandboxProvider({ transport: new MockE2bTransport() });
  server = createProviderServer({ provider });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

beforeEach(startServer);
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function ctx(overrides: Partial<ProviderOpContext> = {}): ProviderOpContext {
  return { deadlineMs: 5_000, idempotencyKey: "idem-1", ...overrides };
}

const SPEC: CreateSandboxSpec = {
  resourceLabels: { tenant: "acme", run: "r-42" },
  command: "run.sh",
  args: ["--fast"],
  env: { TENANT_TOKEN: "s3cr3t" },
  workloadType: "coding",
};

let seq = 0;
async function created(driver: NetworkedProviderDriver, envOverride?: Record<string, string>): Promise<string> {
  const spec = envOverride ? { ...SPEC, env: { ...SPEC.env, ...envOverride } } : SPEC;
  seq += 1;
  const r = await driver.create(spec, ctx({ idempotencyKey: `c-${seq}` }));
  return r.sandboxId;
}

describe("create over the wire", () => {
  it("round-trips and echoes the caller's own resourceLabels", async () => {
    const driver = new NetworkedProviderDriver({ baseUrl });
    const result: CreateResult = await driver.create(SPEC, ctx());
    expect(result.sandboxId).toMatch(/^sbx-/);
    expect(result.resourceLabels).toEqual(SPEC.resourceLabels);
    expect(typeof result.providerOpId).toBe("string");
  });

  it("idempotency replay IN-PROCESS: same key returns the same sandboxId (no server restart)", async () => {
    const driver = new NetworkedProviderDriver({ baseUrl });
    const first = await driver.create(SPEC, ctx({ idempotencyKey: "same-key" }));
    const second = await driver.create(SPEC, ctx({ idempotencyKey: "same-key" }));
    expect(second.sandboxId).toBe(first.sandboxId);

    const other = await driver.create(SPEC, ctx({ idempotencyKey: "different-key" }));
    expect(other.sandboxId).not.toBe(first.sandboxId);
  });
});

describe("execute over the wire", () => {
  it("crosses byte-free — opaque stdoutRef/stderrRef, never inline bytes", async () => {
    const driver = new NetworkedProviderDriver({ baseUrl });
    const sandboxId = await created(driver);
    const result: ExecuteResult = await driver.execute(
      { sandboxId, command: "run.sh", args: [], env: {} },
      ctx({ idempotencyKey: "e-1" }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdoutRef).toBe(`ref:stdout:${sandboxId}`);
    expect(result.stderrRef).toBe(`ref:stderr:${sandboxId}`);
    // no customer bytes fields anywhere on the result
    expect(Object.keys(result)).not.toContain("stdout");
    expect(Object.keys(result)).not.toContain("stderr");
  });

  it("ZERO-DEADLINE verdict is DRIVER-owned: the server is NOT hit and the result is a deterministic timeout", async () => {
    let calls = 0;
    const countingFetch: typeof fetch = (input, init) => {
      calls += 1;
      return fetch(input, init);
    };
    const driver = new NetworkedProviderDriver({ baseUrl, fetch: countingFetch });

    // a POSITIVE-deadline execute DOES hit the server (guards against "always short-circuit")
    const sandboxId = await created(driver);
    const callsAfterCreate = calls;
    await driver.execute({ sandboxId, command: "run.sh", args: [], env: {} }, ctx({ deadlineMs: 5_000, idempotencyKey: "e-pos" }));
    expect(calls).toBe(callsAfterCreate + 1);

    // a ZERO/negative-deadline execute short-circuits: no additional fetch
    const before = calls;
    const zero = await driver.execute(
      { sandboxId, command: "run.sh", args: [], env: {} },
      ctx({ deadlineMs: 0, idempotencyKey: "e-zero" }),
    );
    expect(calls).toBe(before);
    expect(zero.timedOut).toBe(true);
    expect(zero.exitCode).toBeNull();
    expect(zero.signal).toBe("SIGKILL");
    expect(zero.stdoutRef).toBe(`ref:stdout:${sandboxId}`);
  });
});

describe("error vocab survives the wire round-trip", () => {
  it("execute against an unknown sandboxId → SandboxNotFoundError crosses as its class", async () => {
    const driver = new NetworkedProviderDriver({ baseUrl });
    await expect(
      driver.execute({ sandboxId: "sbx-does-not-exist", command: "x", args: [], env: {} }, ctx({ idempotencyKey: "e-nf" })),
    ).rejects.toBeInstanceOf(SandboxNotFoundError);
  });

  it("execute with a blocked-egress directive → SandboxEgressDeniedError + its destinationClass", async () => {
    const driver = new NetworkedProviderDriver({ baseUrl });
    // The egress directive is read from the EXECUTE env (decodeExecuteFaults), not create —
    // so a plain create then an execute carrying the directive is what triggers the denial.
    const sandboxId = await created(driver);
    let thrown: unknown;
    try {
      await driver.execute(
        { sandboxId, command: "curl", args: [], env: { [EGRESS_DIRECTIVE_KEY]: "private" } },
        ctx({ idempotencyKey: "e-egress" }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SandboxEgressDeniedError);
    expect((thrown as SandboxEgressDeniedError).destinationClass).toBe("private");
  });

  it("NEGATIVE over the wire: a garbled/unknown err body surfaces as a WireProtocolError at the DRIVER (never a silent ok)", async () => {
    // Inject a fetch that returns an err envelope whose class name the codec does not know.
    // The driver's #post -> decodeOpResponse must fault, not resolve.
    const garbledFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ err: { name: "TotallyUnknownError", message: "???" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const driver = new NetworkedProviderDriver({ baseUrl, fetch: garbledFetch });
    await expect(
      driver.execute({ sandboxId: "sbx-x", command: "x", args: [], env: {} }, ctx({ idempotencyKey: "e-garble" })),
    ).rejects.toBeInstanceOf(WireProtocolError);
  });

  it("an UNWIRED op path returns an err envelope, never a spurious ok (prototype-inherited key guard)", async () => {
    // Drive the RAW server (the driver only ever POSTs create/execute). An inherited
    // Object.prototype key like `constructor` must NOT resolve to a handler.
    const res = await fetch(`${baseUrl}/op/constructor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: {}, ctx: ctx({ idempotencyKey: "proto" }) }),
    });
    const parsed = JSON.parse(await res.text());
    expect(parsed).not.toHaveProperty("ok");
    expect(parsed).toHaveProperty("err");
  });
});

describe("no sensitive projection crosses in a create/execute RESULT", () => {
  it("the raw response bodies carry no env/secrets/command/logs", async () => {
    const seen: string[] = [];
    const capturingFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      seen.push(await res.clone().text());
      return res;
    };
    const driver = new NetworkedProviderDriver({ baseUrl, fetch: capturingFetch });
    const { sandboxId } = await driver.create(SPEC, ctx({ idempotencyKey: "sens-c" }));
    await driver.execute({ sandboxId, command: "run.sh", args: [], env: {} }, ctx({ idempotencyKey: "sens-e" }));

    expect(seen.length).toBe(2);
    for (const body of seen) {
      // The concrete secret value + the tenant command (both present in the create REQUEST)
      // must NOT appear anywhere in the RESULT body — a real, non-vacuous leak trap.
      expect(body).not.toContain("s3cr3t");
      expect(body).not.toContain("run.sh");
      const parsed = JSON.parse(body);
      expect(parsed).toHaveProperty("ok");
      // And the result projection exposes no sensitive KEYS (precise, not brittle to a
      // benign field whose name merely contains a substring).
      const keys = Object.keys(parsed.ok as Record<string, unknown>);
      for (const forbidden of ["env", "secrets", "command", "logs"]) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });
});
