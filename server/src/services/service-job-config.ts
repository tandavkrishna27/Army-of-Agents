// server/src/services/service-job-config.ts
//
// SVC-001 — submit-time validation for the `service` workload.
//
// This exists for the same reason BRW-001's browser equivalent does. `buildJobEnvelope`
// passes the job's raw `input` blob through as the workload, gated only by
// `jobEnvelopeV1Schema.safeParse`, which returns null — and therefore NO LEASE — on any
// mismatch. The submission surface types `input` as `z.record(z.unknown())`. So a service
// input that does not exactly satisfy the strict frozen schema submits fine with a 201 and
// then silently never leases, with no error anywhere a founder can see.
//
// ★ CLAUSE (d) — WHAT IT BUYS, AND WHAT IT DOES NOT.
//
// "No public port/ingress configuration is accepted" governs DECLARATIVE CONFIGURATION,
// not reachability. E2B serves arbitrary in-sandbox ports to the public internet
// unauthenticated, at a URL derivable from the sandboxId — measured directly in BRW-002's
// terrain, in this same lane. A service that merely LISTENS on a port is publicly
// reachable with no ingress configuration at all. Nothing here changes that. A green
// clause (d) must NOT be read as "services cannot be publicly reached"; those are
// different guarantees and only one of them is delivered by this file.
//
// That is also why `args` is not scanned for `--port`. Rejecting a process argument would
// be theatre: it would not close the reachability path, and it WOULD break legitimate
// services that bind a port internally, which is the normal case rather than the
// exception.
//
// THE ALLOW-LIST IS DERIVED, THE DENY-SET IS NOT. The allowed fields come from
// `serviceWorkloadV1Schema.shape`, so they cannot drift from the frozen contract. But
// derivation alone auto-widens: if a field were added to the frozen schema, it would
// become allowed here silently. The explicit deny-set gives the ingress refusal its own
// reason and its own mutation signature, and a module-load guard asserts the two sets stay
// disjoint so they can never contradict each other.
import { serviceWorkloadV1Schema } from "@armyofagents/worker-protocol";

export type NormalizeServiceJobInputResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/**
 * Keys that name public exposure. Refused with their OWN reason so the refusal is
 * distinguishable from a generic unknown field — if both collapsed to one reason, this
 * set could be deleted without a single test going red.
 */
export const SERVICE_INGRESS_DENY_KEYS: readonly string[] = Object.freeze([
  "port",
  "ports",
  "ingress",
  "publicPort",
  "publicUrl",
  "hostname",
  "host",
  "url",
  "expose",
  "exposedPorts",
  "domain",
  "subdomain",
]);

/** Derived from the frozen schema, so it cannot drift from the wire contract. */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set(Object.keys(serviceWorkloadV1Schema.shape));

// Fail at module load rather than at runtime: a key that is both allowed and denied is a
// contradiction, and the frozen schema growing a field named like an ingress key is
// exactly the drift this catches.
for (const key of SERVICE_INGRESS_DENY_KEYS) {
  if (ALLOWED_FIELDS.has(key)) {
    throw new Error(
      `service workload field "${key}" is both allowed by the frozen schema and denied as ` +
        "ingress configuration. Resolve the contradiction before shipping: either the frozen " +
        "contract now carries this field deliberately, or the deny-set is wrong.",
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalise one service job's submission input.
 *
 * Pure and synchronous. Callers MUST run this AFTER their authorization gate, so a denied
 * caller cannot distinguish a malformed input from a valid one — the same ordering
 * constraint BRW-001 established for the browser slot.
 */
export function normalizeServiceJobInput(raw: unknown): NormalizeServiceJobInputResult {
  if (!isPlainObject(raw)) return { ok: false, reason: "not_an_object" };

  // Ingress first: a submission that carries BOTH an ingress key and some other unknown
  // field should report the ingress refusal, which is the one that names a policy.
  for (const key of SERVICE_INGRESS_DENY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      return { ok: false, reason: "ingress_configuration_rejected" };
    }
  }

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(key)) return { ok: false, reason: "unknown_field" };
  }

  // Fixed key order — a stable serialisation is what makes an equivalent resubmission
  // produce an identical `inputHash`, so idempotency keeps working.
  const candidate = {
    serviceId: raw.serviceId,
    serviceInstanceId: raw.serviceInstanceId,
    generation: raw.generation,
    command: raw.command,
    args: raw.args,
    checkpointArtifactId: raw.checkpointArtifactId ?? null,
    gracefulStopSeconds: raw.gracefulStopSeconds,
  };

  const parsed = serviceWorkloadV1Schema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: "frozen_schema_rejected" };

  return { ok: true, value: candidate as Record<string, unknown> };
}


/**
 * Stamp the AUTHORIZED source's service identity over whatever the caller claimed.
 *
 * WHY THIS IS NEEDED AT ALL. Two checks exist and neither can see the other:
 * `serviceSourceIsAdmitted` authorizes on `source.serviceId` / `source.generation` and never
 * sees the workload, while `validateWorkloadInput` sees the workload and never sees the
 * source. Without stamping, a caller authorized to reconcile service A can submit a workload
 * naming service B, and every check passes.
 *
 * ★ THIS COVERS TWO OF THREE IDENTITY FIELDS. `serviceWorkloadV1Schema` requires
 * `serviceId`, `serviceInstanceId` AND `generation`, but `serviceReconcileSourceSchema`
 * carries no `serviceInstanceId` — so there is nothing authorized to stamp it from, and it
 * remains caller-controlled and validated against nothing. Nothing downstream rescues it:
 * `service_instances` has no `company_id` column and `repos.serviceInstances.getById`
 * filters on `id` alone. Instance-identity authorization belongs to SVC-002/SVC-003 and is
 * NOT delivered here. Do not read a green authorization test as covering it.
 *
 * Key order is preserved so an otherwise-unchanged job keeps the same `inputHash`.
 */
export function stampServiceIdentity(
  source: { readonly kind: string; readonly serviceId?: unknown; readonly generation?: unknown },
  validated: Record<string, unknown>,
): Record<string, unknown> {
  // A non-service source must pass through untouched: stamping these keys onto a batch or
  // browser workload would inject fields their strict frozen schemas reject, producing the
  // null envelope and silent non-lease this whole registry exists to prevent.
  if (source.kind !== "service_reconcile") return validated;
  return {
    serviceId: source.serviceId,
    serviceInstanceId: validated.serviceInstanceId,
    generation: source.generation,
    command: validated.command,
    args: validated.args,
    checkpointArtifactId: validated.checkpointArtifactId ?? null,
    gracefulStopSeconds: validated.gracefulStopSeconds,
  };
}
