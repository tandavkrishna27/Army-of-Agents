// DEP-012 Slice 4+5 (P4/Cred-2) — the adapter-manager error-boundary leak fence.
//
// A raw e2b SDK throw reaching the server's catch would be forwarded VERBATIM by
// serializeError, whose TWO unmodelled arms (`err instanceof Error → err.message` AND the
// non-Error `String(err)`) can carry a leaked provider-auth value. The fence maps ANY
// non-modelled error to a FIXED generic WireProtocolError BEFORE encoding. This proves,
// over the REAL wire, that BOTH a thrown Error AND a thrown non-Error whose text embeds a
// planted secret leave NO trace in the response — while the MODELLED classes still pass
// through with their fixed-vocabulary identity intact.

import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CreateSandboxSpec,
  ProviderOpContext,
  SandboxProvider,
} from "@armyofagents/worker-daemon";
import { encodeOpRequest } from "@armyofagents/provider-wire/codec";
import { SandboxNotFoundError } from "@armyofagents/sandbox-e2b-provider/errors.js";

import { createProviderServer } from "../server.js";

const PLANTED = "sk-PLANTED-PROVIDER-SECRET-must-never-leak";

const SPEC: CreateSandboxSpec = {
  resourceLabels: { tenant: "acme", run: "r-1" },
  command: "run.sh",
  args: [],
  env: { PROVIDER_TOKEN: PLANTED },
  workloadType: "coding",
};
const CTX: ProviderOpContext = { deadlineMs: 5_000, idempotencyKey: "idem-1" };

/** A provider whose EVERY op throws `makeError()`. Only `create`/`execute` are reached on
 * an ungated server (raw handlers); the rest are never called. */
function throwingProvider(makeError: () => unknown): SandboxProvider {
  const thrower = async (): Promise<never> => {
    throw makeError();
  };
  return new Proxy({}, { get: () => thrower }) as unknown as SandboxProvider;
}

let server: ReturnType<typeof createProviderServer>;
let baseUrl: string;

async function startWith(provider: SandboxProvider): Promise<void> {
  // UNGATED (no control-plane key) so `create` routes to its raw handler and the provider
  // throw reaches the server's catch — the fence site.
  server = createProviderServer({ provider });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function postCreateRaw(): Promise<string> {
  const res = await fetch(`${baseUrl}/op/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: encodeOpRequest(SPEC, CTX),
  });
  return res.text();
}

describe("DEP-012 Cred-2 — AM error boundary drops unmodelled error text", () => {
  it("a thrown Error whose message embeds a secret leaves NO trace on the wire", async () => {
    await startWith(throwingProvider(() => new Error(`e2b create failed for ${PLANTED} at region x`)));
    const body = await postCreateRaw();
    expect(body).not.toContain(PLANTED);
    // It is still an err envelope (a fault never reads as ok), coded to the generic class.
    const parsed = JSON.parse(body) as { err?: { name?: string; message?: string } };
    expect(parsed.err?.name).toBe("WireProtocolError");
    expect(parsed.err?.message).not.toContain(PLANTED);
  });

  it("a thrown NON-Error string embedding a secret leaves NO trace on the wire", async () => {
    // Hits serializeError's SECOND arm (`String(err)`), which the fence also drops.
    await startWith(throwingProvider(() => `raw string leak ${PLANTED}`));
    const body = await postCreateRaw();
    expect(body).not.toContain(PLANTED);
    const parsed = JSON.parse(body) as { err?: { name?: string } };
    expect(parsed.err?.name).toBe("WireProtocolError");
  });

  it("a thrown non-Error object with a leaking toString leaves NO trace on the wire", async () => {
    await startWith(throwingProvider(() => ({ toString: () => `obj leak ${PLANTED}` })));
    const body = await postCreateRaw();
    expect(body).not.toContain(PLANTED);
  });

  it("a MODELLED provider error still passes through with its fixed-vocabulary identity", async () => {
    // SandboxNotFoundError carries no tenant data; the fence must NOT flatten it (the driver
    // needs to reconstruct the authoritative class).
    await startWith(throwingProvider(() => new SandboxNotFoundError()));
    const body = await postCreateRaw();
    const parsed = JSON.parse(body) as { err?: { name?: string } };
    expect(parsed.err?.name).toBe("SandboxNotFoundError");
  });
});
