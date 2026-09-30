// -----------------------------------------------------------------------------
// provider-wire codec (DEP-012 Slice 1 · Unit A).
//
// The per-op request/response envelopes + (de)serialization + the error-vocab
// codec, imported by BOTH the adapter-manager server and the networked driver.
// It is provider-NEUTRAL: it serves the frozen provider ops, it does not extend
// them. Unit A wires only `create` + `execute`, but the codec itself is op-agnostic
// (it carries opaque `args`), so no op is special-cased here.
//
// THE ERROR VOCAB. The wire preserves the error CLASS by `.name` + its discriminant,
// so a caller's duck-typed (`.name` + field) checks — and the DEP-008 conformance
// suite — see production identities across the hop. The reconstructed classes are the
// AUTHORITATIVE ones: `UnsupportedProviderOperation`/`SandboxNotFoundError` are
// worker-daemon's (re-exported through the e2b leaf's `errors.js` as the single import
// site), `SandboxEgressDeniedError` is the provider-neutral egress denial (worker-daemon
// has no class for it). An UNKNOWN or garbled payload maps to a generic `WireProtocolError`
// — NEVER silently to an `ok` result.
// -----------------------------------------------------------------------------

import type { ProviderOpContext } from "@armyofagents/worker-daemon";
import {
  ResourceNotAvailableError,
  SandboxEgressDeniedError,
  SandboxNotFoundError,
  UnsupportedProviderOperation,
} from "@armyofagents/sandbox-e2b-provider/errors.js";

import type { OwnedLabelsCapability } from "./capability.js";

/**
 * A wire-transport / protocol failure that is NOT one of the modelled provider
 * domain errors: a garbled body, a response that is neither `ok` nor `err`, or an
 * `err` payload whose class name the codec does not recognise. It exists so a
 * malformed hop can never be mistaken for success.
 */
export class WireProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireProtocolError";
  }
}

/**
 * The request envelope every op crosses in: opaque `args` + the op context, plus
 * an OPTIONAL owned-labels `capability` (DEP-012 Unit B1).
 *
 * ★ The capability is OPTIONAL on the envelope so `create`'s `{args, ctx}` body stays
 * BYTE-IDENTICAL (Unit A) — `create` is gate-free and omits it. But `execute` REQUIRES
 * it: the adapter-manager execute gate refuses when it is absent or unverifiable (it
 * NEVER dispatches on absence). `decodeOpRequest` carries a present capability THROUGH
 * (it no longer silently drops extras — the R2 fall-open) and rejects a malformed one.
 */
export interface OpRequestEnvelope {
  readonly args: unknown;
  readonly ctx: ProviderOpContext;
  readonly capability?: OwnedLabelsCapability;
}

/** The serialized error shape. `name` selects the class; the optional STRUCTURED fields
 * (`operation`/`destinationClass`) carry only the modelled class discriminants — never a
 * sensitive projection. `message` is server-authored diagnostic text (not tenant data);
 * an UNMODELLED error forwards its own `message` verbatim, so a producer must not put
 * sensitive values there. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly operation?: string;
  readonly destinationClass?: string;
}

// ---- request codec (client encodes, server decodes) -------------------------

export function encodeOpRequest(args: unknown, ctx: ProviderOpContext, capability?: OwnedLabelsCapability): string {
  // The capability key is emitted ONLY when present, so a create request (no
  // capability) is byte-identical to the Unit-A `{ args, ctx }` body.
  const envelope: OpRequestEnvelope = capability === undefined ? { args, ctx } : { args, ctx, capability };
  return JSON.stringify(envelope);
}

export function decodeOpRequest(body: string): OpRequestEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new WireProtocolError("request body is not valid JSON");
  }
  if (!isRecord(parsed) || !("args" in parsed) || !isValidCtx(parsed.ctx)) {
    throw new WireProtocolError("request body is missing a valid { args, ctx } envelope");
  }
  // Carry a PRESENT capability through (no longer a silently-dropped extra — R2). A
  // present-but-MALFORMED capability is a wire error, never carried as junk. Absence is
  // fine here (op-agnostic); the execute route enforces presence for `execute`.
  if ("capability" in parsed && parsed.capability !== undefined) {
    if (!isValidCapability(parsed.capability)) {
      throw new WireProtocolError("request body carries a malformed capability");
    }
    return { args: parsed.args, ctx: parsed.ctx, capability: parsed.capability };
  }
  return { args: parsed.args, ctx: parsed.ctx };
}

// ---- response codec (server encodes, client decodes) ------------------------

export function encodeOkResponse(result: unknown): string {
  return JSON.stringify({ ok: result });
}

export function encodeErrResponse(err: unknown): string {
  return JSON.stringify({ err: serializeError(err) });
}

/**
 * Decode a server response. Returns the `ok` result, or THROWS the reconstructed
 * domain error, or THROWS a `WireProtocolError` for anything unrecognised. It never
 * returns for an `err`/garbled body — a fault can never read as success.
 */
export function decodeOpResponse<R>(body: string): R {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new WireProtocolError("response body is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new WireProtocolError("response body is not an object");
  }
  if ("ok" in parsed) {
    return parsed.ok as R;
  }
  if ("err" in parsed) {
    throw reconstructError(parsed.err);
  }
  throw new WireProtocolError("response body is neither an ok nor an err envelope");
}

// ---- error vocab ------------------------------------------------------------

/** Extract the class name + its discriminant from a thrown error. Only the modelled
 * discriminants (`operation`, `destinationClass`) cross — nothing else. */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof UnsupportedProviderOperation) {
    return { name: err.name, message: err.message, operation: String(err.operation) };
  }
  if (err instanceof SandboxEgressDeniedError) {
    return { name: err.name, message: err.message, destinationClass: err.destinationClass };
  }
  if (err instanceof SandboxNotFoundError) {
    return { name: err.name, message: err.message };
  }
  // The UNIFORM ownership-gate denial (DEP-012 Unit B1). It carries NO discriminant —
  // its message is fixed by the class, so a foreign/not-found/verify-fail refusal all
  // serialize byte-identically (the oracle collapse). Explicit here (not via the generic
  // Error fallthrough) so it is SYMMETRIC with reconstructError and mutation-visible.
  if (err instanceof ResourceNotAvailableError) {
    return { name: err.name, message: err.message };
  }
  // Anything else is not a modelled domain error — carry only its name/message; the
  // decoder maps an unrecognised name to a generic WireProtocolError.
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: "WireProtocolError", message: String(err) };
}

/**
 * Is `err` one of the MODELLED wire error classes — i.e. a class whose serialized
 * `message` is fixed by the class vocabulary, never tenant data? Additive predicate
 * (DEP-012 Slice 4+5 / Cred-2). It does NOT change `serializeError`'s behaviour — the
 * adapter-manager's error boundary uses it to decide, AM-LOCALLY, whether to pass an
 * error through as-is or substitute a fixed generic `WireProtocolError` (so an
 * unmodelled throw's `err.message` / `String(err)` can never carry a leaked value over
 * the wire). Lives HERE, in provider-wire, because the concrete provider error classes
 * are confined out of the adapter-manager request path (the AM boundary checker forbids
 * naming `@armyofagents/sandbox-e2b-provider` there), and this module already imports
 * the whole modelled vocabulary.
 */
export function isModelledWireError(err: unknown): boolean {
  return (
    err instanceof WireProtocolError ||
    err instanceof ResourceNotAvailableError ||
    err instanceof SandboxNotFoundError ||
    err instanceof SandboxEgressDeniedError ||
    err instanceof UnsupportedProviderOperation
  );
}

/** Rebuild the AUTHORITATIVE domain error from a serialized payload. An unknown or
 * malformed name maps to a generic `WireProtocolError` — never silently discarded. */
export function reconstructError(raw: unknown): Error {
  if (!isRecord(raw) || typeof raw.name !== "string") {
    return new WireProtocolError("err payload is missing a class name");
  }
  const message = typeof raw.message === "string" ? raw.message : "";
  switch (raw.name) {
    case "UnsupportedProviderOperation": {
      // The DeclinableOperation union is wider than ProviderOperation; the ctor
      // accepts the string discriminant, re-widened via a narrow cast.
      const operation = typeof raw.operation === "string" ? raw.operation : "";
      return new UnsupportedProviderOperation(operation as ConstructorParameters<typeof UnsupportedProviderOperation>[0]);
    }
    case "SandboxNotFoundError":
      return new SandboxNotFoundError();
    case "ResourceNotAvailableError":
      // SYMMETRIC with serializeError: miss this and the uniform gate denial silently
      // degrades to WireProtocolError on decode, breaking the oracle collapse.
      return new ResourceNotAvailableError();
    case "SandboxEgressDeniedError": {
      const destinationClass = typeof raw.destinationClass === "string" ? raw.destinationClass : "";
      return new SandboxEgressDeniedError(destinationClass);
    }
    default:
      return new WireProtocolError(`unrecognised error class over the wire: ${raw.name}${message ? ` (${message})` : ""}`);
  }
}

// ---- helpers ----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidCtx(value: unknown): value is ProviderOpContext {
  return isRecord(value) && typeof value.deadlineMs === "number" && typeof value.idempotencyKey === "string";
}

/**
 * Structural validation of a wire capability. It confirms only the SHAPE (an ordered
 * label tuple + version/audience/expiry/sig of the right primitive types) — the
 * SIGNATURE is verified by the adapter-manager verify against the pinned public key.
 * A malformed capability is rejected here so junk never reaches the gate as if valid.
 */
function isValidCapability(value: unknown): value is OwnedLabelsCapability {
  if (!isRecord(value)) return false;
  if (typeof value.v !== "number" || typeof value.audience !== "string") return false;
  if (typeof value.expiresAt !== "number" || typeof value.sig !== "string") return false;
  const labels = value.ownedLabels;
  if (!isRecord(labels)) return false;
  return (
    typeof labels.organizationId === "string" &&
    typeof labels.targetId === "string" &&
    typeof labels.workerId === "string" &&
    typeof labels.jobId === "string" &&
    typeof labels.attempt === "number" &&
    typeof labels.leaseId === "string" &&
    typeof labels.deviceGeneration === "number"
  );
}
