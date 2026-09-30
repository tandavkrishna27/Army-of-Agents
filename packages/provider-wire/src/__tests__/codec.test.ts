import { describe, expect, it } from "vitest";
import type {
  CreateResult,
  CreateSandboxSpec,
  ExecuteResult,
  ProviderOpContext,
} from "@armyofagents/worker-daemon";
import {
  SandboxEgressDeniedError,
  SandboxNotFoundError,
  UnsupportedProviderOperation,
} from "@armyofagents/sandbox-e2b-provider/errors.js";

import {
  WireProtocolError,
  decodeOpRequest,
  decodeOpResponse,
  encodeErrResponse,
  encodeOkResponse,
  encodeOpRequest,
} from "../codec.js";

const CTX: ProviderOpContext = { deadlineMs: 5_000, idempotencyKey: "idem-key-1" };

const SPEC: CreateSandboxSpec = {
  resourceLabels: { tenant: "acme", run: "r1" },
  command: "echo",
  args: ["hi"],
  env: { FOO: "bar" },
  workloadType: "coding",
};

describe("request codec", () => {
  it("round-trips a create request preserving args + ctx", () => {
    const body = encodeOpRequest(SPEC, CTX);
    expect(typeof body).toBe("string");
    const decoded = decodeOpRequest(body);
    expect(decoded.args).toEqual(SPEC);
    expect(decoded.ctx).toEqual(CTX);
  });

  it("rejects a garbled request body with a WireProtocolError (never a phantom empty ctx)", () => {
    expect(() => decodeOpRequest("}{not json")).toThrow(WireProtocolError);
    expect(() => decodeOpRequest(JSON.stringify({ args: SPEC }))).toThrow(WireProtocolError);
  });
});

describe("ok response codec", () => {
  it("round-trips an ok CreateResult", () => {
    const result: CreateResult = {
      sandboxId: "sbx-000001",
      providerOpId: "e2b-create-1",
      resourceLabels: SPEC.resourceLabels,
    };
    const body = encodeOkResponse(result);
    expect(decodeOpResponse<CreateResult>(body)).toEqual(result);
  });

  it("round-trips an ok ExecuteResult with opaque refs (no bytes)", () => {
    const result: ExecuteResult = {
      providerOpId: "e2b-execute-1",
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdoutRef: "ref:stdout:sbx-000001",
      stderrRef: "ref:stderr:sbx-000001",
    };
    const body = encodeOkResponse(result);
    expect(decodeOpResponse<ExecuteResult>(body)).toEqual(result);
  });
});

describe("error-vocab codec — the class survives by .name + discriminant", () => {
  it("preserves SandboxNotFoundError across the wire", () => {
    const body = encodeErrResponse(new SandboxNotFoundError());
    let thrown: unknown;
    try {
      decodeOpResponse(body);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SandboxNotFoundError);
    expect((thrown as Error).name).toBe("SandboxNotFoundError");
  });

  it("preserves SandboxEgressDeniedError AND its destinationClass discriminant", () => {
    const body = encodeErrResponse(new SandboxEgressDeniedError("private"));
    let thrown: unknown;
    try {
      decodeOpResponse(body);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SandboxEgressDeniedError);
    expect((thrown as SandboxEgressDeniedError).destinationClass).toBe("private");
  });

  it("preserves UnsupportedProviderOperation AND its operation discriminant", () => {
    const body = encodeErrResponse(new UnsupportedProviderOperation("inspect"));
    let thrown: unknown;
    try {
      decodeOpResponse(body);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnsupportedProviderOperation);
    expect((thrown as UnsupportedProviderOperation).operation).toBe("inspect");
  });

  it("NEGATIVE: an unknown/garbled error payload maps to a generic wire error, never silently to ok", () => {
    const garbled = JSON.stringify({ err: { name: "TotallyUnknownError", message: "???" } });
    expect(() => decodeOpResponse(garbled)).toThrow(WireProtocolError);

    // A response that is neither {ok} nor {err} must also fault, not resolve.
    expect(() => decodeOpResponse(JSON.stringify({ surprise: 1 }))).toThrow(WireProtocolError);
    expect(() => decodeOpResponse("}{ not json")).toThrow(WireProtocolError);
  });
});
