// server/src/services/desktop-device-projection.ts
//
// DSK-001 Lane D (D17) — the redacted projection behind the owner-scoped device listing.
//
// The frozen wire cannot carry this: `secretHandleRefSchema` is `.strict()` with exactly
// three fields and is byte-gated in CI (F26). So the listing is REST over the org's own
// rows, and THIS module is the security artifact — the route is only delivery.
//
// Modelled on `PROVIDER_PROJECTION_KEYS` / `projectionLeakKeys`
// (`packages/sandbox-provider-contract/src/port.ts:70-100`), including the reason that
// helper exists: `Object.keys` sees the REAL runtime key set, so a caller who spreads an
// extra field past the static type is still caught.
//
// OWNER SCOPING IS A FILTER, NEVER A DISCLOSURE. F31 notes that the redacted
// `WorkerSummary` allowlist drops `ownerUserId` "so it cannot serve an owner-scoped
// view", which reads like an instruction to emit the owner. It is the opposite: the view
// needs `owner_user_id` as a QUERY INPUT, and `WorkerSummary` cannot serve it because by
// the time you hold one the column is already gone, so you cannot filter on it. Building
// the query from the org's own targets outward puts the scoping in SQL and keeps the
// column out of the response — which is exactly why D17 calls that construction safe
// where a generic worker join is not.

import type { DeviceLivenessStatus } from "./device-liveness.js";

/**
 * The frozen allowlist. Eight fields, chosen so an operator can answer "which of my
 * machines are enrolled, are they alive, and has any been re-enrolled behind my back" —
 * and nothing else. `deviceGeneration` is here for that last question specifically: a
 * silent re-enrolment is the failure this whole ticket is organised around.
 *
 * `health` (E11 M2) is the ONE COMPUTED field, not a column: it is the read-time liveness
 * verdict `classifyDeviceLiveness` derives from `lastSeenAt` against the DB clock. It is
 * emitted here rather than `status` because `workers.status` never advances past
 * `enrolled`/`revoked` and so says nothing about liveness (see `device-liveness.ts`).
 */
export const DESKTOP_DEVICE_PROJECTION_KEYS = [
  "deviceId",
  "targetSlug",
  "label",
  "status",
  "deviceGeneration",
  "enrolledAt",
  "lastSeenAt",
  "health",
] as const;

export type DesktopDeviceProjectionKey = (typeof DESKTOP_DEVICE_PROJECTION_KEYS)[number];

/**
 * Every column of `workers` and `execution_targets` that is deliberately NOT emitted.
 *
 * This list exists so I16's exhaustiveness test can require that EVERY column is
 * classified — allowlisted or omitted-on-purpose. A new column then fails the build until
 * someone decides about it, which is what "a future column defaults hidden" requires. The
 * weak alternative ("the response has these seven keys") passes forever while the schema
 * grows underneath it.
 *
 * Reasons, so the next person does not have to re-derive them:
 *   ownerUserId               scoping input, not output (see the header)
 *   executionTargetId         F31's actual lesson — WORKER_SUMMARY_COLUMNS had to drop
 *                             this, and re-adding it hands back the join key a caller
 *                             could pivot on. `targetSlug` carries the human meaning
 *                             without the identifier.
 *   targetAuthorityKey        encodes `owner:<org>:<user>` — it IS ownerUserId respelled
 *   workerTokenHash           credential material
 *   devicePublicKey           credential material
 *   deviceThumbprint          derived from credential material; not needed to answer any
 *                             question this listing exists to answer
 *   profileHash / profileSnapshot / registeredProfile / registeredProfileHash /
 *   providerConstraintProfile / config / capabilities
 *                             free-form JSON. An allowlist that admits an arbitrary blob
 *                             is not an allowlist.
 *   organizationId            the caller already scoped by it; echoing it back widens the
 *                             surface for nothing
 *   scope / kind / trustClass the query already pins these (owner-scoped desktop targets)
 *   id / slug                 the target's own identifiers; `deviceId` and `targetSlug`
 *                             are the projected forms
 *   revokedAt / createdAt / updatedAt
 *                             row bookkeeping; `status` and `lastSeenAt` are the
 *                             operator-meaningful facts
 */
export const DELIBERATELY_OMITTED_COLUMNS = [
  // workers
  "id",
  "scope",
  "organizationId",
  "ownerUserId",
  "executionTargetId",
  "targetAuthorityKey",
  "devicePublicKey",
  "deviceThumbprint",
  "profileHash",
  "profileSnapshot",
  "revokedAt",
  "createdAt",
  "updatedAt",
  // execution_targets
  "slug",
  "kind",
  "trustClass",
  "capabilities",
  "registeredProfile",
  "registeredProfileHash",
  "providerConstraintProfile",
  "config",
  "workerTokenHash",
] as const;

/**
 * One enrolled desktop device, as the API returns it. Every field is operator-meaningful
 * and none identifies a credential, an owner, or a join key.
 */
export interface DesktopDeviceProjection {
  readonly deviceId: string;
  readonly targetSlug: string;
  readonly label: string;
  readonly status: string;
  readonly deviceGeneration: number;
  readonly enrolledAt: string | null;
  readonly lastSeenAt: string | null;
  /** Read-time liveness verdict from `classifyDeviceLiveness` (E11 M2). Computed by the
   *  caller and passed through — never a column. */
  readonly health: DeviceLivenessStatus;
}

/** The joined row this projection is built from. Deliberately wider than the output. */
export interface DesktopDeviceRow {
  readonly deviceId: string;
  readonly targetSlug: string;
  readonly label: string;
  readonly status: string;
  readonly deviceGeneration: number;
  readonly enrolledAt: Date | null;
  readonly lastSeenAt: Date | null;
  /** Injected by the caller (`listDesktopDevices`) after classifying liveness against the
   *  DB clock. Not a column on `workers`/`execution_targets`. */
  readonly health: DeviceLivenessStatus;
  readonly [column: string]: unknown;
}

const PROJECTION_KEY_SET: ReadonlySet<string> = new Set(DESKTOP_DEVICE_PROJECTION_KEYS);

/**
 * Build the projection by NAMING each field, never by spreading and deleting.
 *
 * A spread-then-omit implementation inherits every future column by default and relies on
 * someone remembering to remove it — which is the shape that produced F31 in the first
 * place. Constructing field-by-field means a new column is invisible here until someone
 * writes it in.
 */
export function projectDesktopDevice(row: DesktopDeviceRow): DesktopDeviceProjection {
  return {
    deviceId: row.deviceId,
    targetSlug: row.targetSlug,
    label: row.label,
    status: row.status,
    deviceGeneration: row.deviceGeneration,
    enrolledAt: row.enrolledAt ? row.enrolledAt.toISOString() : null,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    health: row.health,
  };
}

/**
 * Keys of `projection` that are NOT in the allowlist — every one is a disclosure.
 *
 * The same single shared gate both the unit tests and the route-level canary test use, so
 * no forked copy can drift. `Object.keys` reads the real runtime key set, which is what
 * catches a widened object whose static type is still clean.
 */
export function desktopDeviceLeakKeys(projection: DesktopDeviceProjection): string[] {
  return Object.keys(projection).filter((key) => !PROJECTION_KEY_SET.has(key));
}
