// -----------------------------------------------------------------------------
// DEP-012 Slice 1 · Unit B1 — codec additions: the capability envelope field +
// the symmetric ResourceNotAvailableError vocab.
//
//   - ResourceNotAvailableError round-trips SYMMETRICALLY (serializeError AND
//     reconstructError) — miss the reconstruct case and the uniform error silently
//     degrades to WireProtocolError on decode, breaking the oracle collapse.
//   - The capability is carried THROUGH decodeOpRequest (not silently dropped — the
//     R2 fall-open), and a MALFORMED capability is rejected at decode.
//   - create's `{args, ctx}` body stays BYTE-IDENTICAL when no capability is passed
//     (Unit A's 17 tests must stay green).
// -----------------------------------------------------------------------------

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ExecuteInput, ProviderOpContext, ResourceLabels } from "@armyofagents/worker-daemon";
import { ResourceNotAvailableError } from "@armyofagents/sandbox-e2b-provider/errors.js";

import {
  WireProtocolError,
  decodeOpRequest,
  decodeOpResponse,
  encodeErrResponse,
  encodeOpRequest,
  reconstructError,
  serializeError,
} from "../codec.js";
import {
  OWNED_LABELS_CAPABILITY_AUDIENCE,
  OWNED_LABELS_CAPABILITY_VERSION,
  signOwnedLabelsCapability,
} from "../capability.js";

const CTX: ProviderOpContext = { deadlineMs: 5_000, idempotencyKey: "idem-1" };
const INPUT: ExecuteInput = { sandboxId: "sbx-000001", command: "run.sh", args: [], env: {} };
const OWNED: ResourceLabels = {
  organizationId: "org-1",
  targetId: "tgt-1",
  workerId: "wkr-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  deviceGeneration: 7,
};

function mintCapability() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return signOwnedLabelsCapability(
    {
      v: OWNED_LABELS_CAPABILITY_VERSION,
      audience: OWNED_LABELS_CAPABILITY_AUDIENCE,
      ownedLabels: OWNED,
      expiresAt: 1_700_000_060_000,
    },
    privateKey,
  );
}

describe("ResourceNotAvailableError crosses the wire SYMMETRICALLY", () => {
  it("serializeError -> reconstructError preserves the class", () => {
    const round = reconstructError(serializeError(new ResourceNotAvailableError()));
    expect(round).toBeInstanceOf(ResourceNotAvailableError);
    expect((round as Error).name).toBe("ResourceNotAvailableError");
  });

  it("decodeOpResponse(encodeErrResponse(RNA)) throws a real ResourceNotAvailableError", () => {
    const body = encodeErrResponse(new ResourceNotAvailableError());
    let thrown: unknown;
    try {
      decodeOpResponse(body);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ResourceNotAvailableError);
  });

  it("the RNA wire body is FIXED (no cause leaks into message) — the oracle collapse", () => {
    // The message is fixed by the class ctor, so every RNA serializes byte-identically
    // regardless of what produced it (foreign / not-found / verify-fail).
    const body = encodeErrResponse(new ResourceNotAvailableError());
    expect(body).toBe(JSON.stringify({ err: { name: "ResourceNotAvailableError", message: "resource not available" } }));
  });
});

describe("the capability envelope field", () => {
  it("is carried THROUGH decodeOpRequest when present (not silently dropped)", () => {
    const cap = mintCapability();
    const decoded = decodeOpRequest(encodeOpRequest(INPUT, CTX, cap));
    expect(decoded.args).toEqual(INPUT);
    expect(decoded.ctx).toEqual(CTX);
    expect(decoded.capability).toEqual(cap);
  });

  it("create stays BYTE-IDENTICAL when no capability is passed ({args, ctx} only)", () => {
    // No capability key at all — Unit A's create body must not change shape.
    const body = encodeOpRequest(INPUT, CTX);
    expect(body).toBe(JSON.stringify({ args: INPUT, ctx: CTX }));
    const decoded = decodeOpRequest(body);
    expect("capability" in decoded ? decoded.capability : undefined).toBeUndefined();
  });

  it("rejects a MALFORMED capability at decode (a non-object / missing fields is a WireProtocolError)", () => {
    const badBodies = [
      JSON.stringify({ args: INPUT, ctx: CTX, capability: "not-an-object" }),
      JSON.stringify({ args: INPUT, ctx: CTX, capability: { v: 1 } }),
      JSON.stringify({ args: INPUT, ctx: CTX, capability: { v: 1, audience: "adapter-manager", ownedLabels: {}, expiresAt: "soon", sig: "x" } }),
    ];
    for (const body of badBodies) {
      expect(() => decodeOpRequest(body)).toThrow(WireProtocolError);
    }
  });
});
