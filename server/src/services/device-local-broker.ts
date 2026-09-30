// server/src/services/device-local-broker.ts
//
// DSK-001 Lane B (D10) — the device-local credential broker PORT.
//
// THE INVARIANT, and the reason this file exists at all: an activation is a
// REFERENCE, never bytes. `device_local` is a distinct `ref_kind` precisely because
// the credential's value never leaves the OS keystore, so a broker that could
// return the value would defeat the whole ref_kind. There is no `value` field
// anywhere in these types, and that is enforced structurally by
// `__tests__/device-local-broker.test.ts` rather than by anyone remembering.
//
// WHY THIS IS SEPARATE FROM `SecretBrokerSet`. That interface's two methods return
// `Promise<string>` (`secret-broker.ts:108-115`) — for this ref_kind the
// `Promise<string>` IS the leak. `dispatchResolvedSecret` already short-circuits
// `device_local` on `refKind` alone, before either broker is touched, so the value
// path is unreachable today; keeping the ports separate is what stops a future
// merge from quietly reconnecting it.
//
// WHY IT LIVES SERVER-SIDE. It is a PORT: the control plane declares the shape and
// something else implements it, exactly as `SecretBrokerSet` +
// `failClosedSecretBrokers` already do. It cannot live in
// `packages/worker-daemon/src` (that manifest is pinned to
// `["@armyofagents/worker-protocol","pino"]` and the boundary checker rejects any
// bare specifier beyond it), and putting it in `packages/worker-keystore` would
// drag the D2 keystore boundary checker across a server-side type for no benefit.
//
// NOTHING CONSUMES THIS YET, and that is the plan rather than an oversight.
// `device_local`'s only production consumer is the fence-aware egress proxy, which
// DENIES it (`egress-proxy.ts:217`) because the server is correctly declining to
// egress a value it cannot hold. The real consumer is device-side and belongs to
// DSK-002. See `DSK-001-lane-B-design.md` §1.

import type { DeviceLocalHandoff } from "./secret-broker.js";

/**
 * The shapes an activation may take. Every arm names a PLACE the consumer reads
 * from — a path, a variable name, an endpoint — never the thing itself.
 *
 * Exported as an array so the invariant is enumerable at runtime and a gate can
 * walk it, the same reason `SECRET_RESOLVE_REJECTION_REASONS` is an array.
 */
export const DEVICE_LOCAL_ACTIVATION_REFERENCE_KINDS = ["file_path", "env_name", "proxy_endpoint"] as const;

export type DeviceLocalActivationReferenceKind =
  (typeof DEVICE_LOCAL_ACTIVATION_REFERENCE_KINDS)[number];

/**
 * The OS-protected reference the consumer uses. NOT the value.
 *
 * The `proxy_endpoint` arm is deliberate: F24 admits `device_local + fence_proxy`,
 * and DSK-002's outcome is to mediate device-local handles through the DAT-004
 * broker plus the fence-aware egress path. Omitting it would force DSK-002 to
 * widen this type on day one.
 */
export type DeviceLocalActivationReference =
  | { readonly kind: "file_path"; readonly path: string }
  | { readonly kind: "env_name"; readonly name: string }
  | { readonly kind: "proxy_endpoint"; readonly url: string };

/**
 * What the caller hands the broker: the authorized handoff, and nothing else.
 *
 * Taking the handoff WHOLE rather than destructured fields is deliberate — the
 * handoff's key set is frozen by test, so this request cannot grow a value-bearing
 * field without that frozen list being edited on purpose.
 */
export interface DeviceLocalActivationRequest {
  readonly handoff: DeviceLocalHandoff;
}

export interface DeviceLocalActivation {
  readonly activationId: string;
  readonly materialization: "env" | "file" | "proxy";
  /** The OS-protected reference the consumer uses. Never the value. */
  readonly reference: DeviceLocalActivationReference;
  /**
   * When the activation stops being usable, as an ISO-8601 instant.
   *
   * D10 specifies `expiresAt <= the lease deadline`.
   *
   * DSK-002 Lane D landed the RULE: `clampActivationExpiry`
   * (`device-local-activation-policy.ts`) clamps a requested TTL to the lease deadline
   * and REFUSES rather than coercing on the three cases that would otherwise mint
   * something special — an absent/NaN deadline (the forever-activation this comment
   * used to warn about), a deadline already passed, and a non-positive TTL.
   *
   * WHAT IS STILL NOT WIRED, so this field still does not imply a guarantee it does not
   * have: no lease deadline REACHES this layer — neither `SecretResolveRequestV1` nor
   * `AuthorizedSecretResolution` carries one — so nothing calls the clamp on this path
   * yet. Threading it is part of wiring a real device-side implementation, which needs
   * the least-privilege host and therefore belongs with DSK-003.
   *
   * It remains safe by construction in the meantime: the only implementation is
   * `failClosedDeviceLocalBroker`, which throws, so no activation can be minted and
   * therefore no unbounded activation can exist.
   */
  readonly expiresAt: string;
}

/**
 * Activate a device-local credential and return a REFERENCE to it.
 *
 * `deactivate` takes only the opaque `activationId`: revoking must not require
 * re-presenting anything about the credential.
 */
export interface DeviceLocalCredentialBroker {
  activate(input: DeviceLocalActivationRequest): Promise<DeviceLocalActivation>;
  deactivate(activationId: string): Promise<void>;
}

/**
 * The default: every activation throws until DSK-002 wires a real device-side
 * implementation. Mirrors `failClosedSecretBrokers` (`secret-broker.ts:119-126`),
 * including naming the ticket that wires it — the difference between "not built
 * yet" and "failing".
 *
 * Fail-closed here means an unwired seam cannot mint an activation, which is the
 * property that makes the unenforced `expiresAt` bound above harmless.
 */
export const failClosedDeviceLocalBroker: DeviceLocalCredentialBroker = {
  async activate() {
    throw new Error("device-local credential broker not wired (DSK-002)");
  },
  async deactivate() {
    throw new Error("device-local credential broker not wired (DSK-002)");
  },
};
