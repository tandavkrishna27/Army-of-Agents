// server/src/services/device-liveness.ts
//
// E11 M2 — DEVICE LIVENESS, computed at read time. What it means for an enrolled
// device to be "healthy", "stale", or "never seen", derived from `workers.lastSeenAt`
// against the current enrolment (`enrolledAt`, so a superseded generation's check-in does
// not count). No column, no migration: the verdict is a pure function of three timestamps
// and a deadline, evaluated inside `listDesktopDevices`.
//
// ── WHY NOT `workers.status` ──────────────────────────────────────────────────────────
//
// `workers.status` is the WRONG signal for liveness and this is measured, not assumed.
// The status CHECK admits `enrolled | active | draining | revoked`, but the enrollment
// writer only ever writes `enrolled` (and revocation writes `revoked`); nothing in the
// tree transitions a worker to `active`/`draining`. So `status` answers "is this row
// revoked?", never "have we heard from this device lately?". Liveness must come from
// `lastSeenAt`, which the session-heartbeat path (`heartbeatSessionProfile`) and the
// lease-activity path (`touchWorkerLeaseProfile`) both advance.
//
// ── THE FAIL-OPEN, MIRRORED FROM SVC-003b ─────────────────────────────────────────────
//
// `service-liveness-deadline.ts` (`classifyServiceInstanceLiveness`) draws the load-bearing
// distinction this module copies: a NULL last-observation is NOT "infinitely old". A device
// that has enrolled but never checked in has no liveness fact to age, so it is `never_seen`
// — never `stale`. Reporting it as stale would be "terminalize a live instance because the
// observation was unreadable", the exact defect SVC-003b names. `never_seen` and `stale` are
// therefore DIFFERENT FACTS and this classifier never collapses one into the other.
//
// ── THE COMPARISON IS STRICT (`>`), ALSO MIRRORED FROM SVC-003b ────────────────────────
//
// An age exactly equal to the deadline is still `healthy`. A deadline is the point PAST
// which a device is condemned, not the point AT which it is.

/** The read-time liveness verdict for one enrolled device. */
export type DeviceLivenessStatus = "never_seen" | "healthy" | "stale";

/**
 * ★ A CONSERVATIVE DEFAULT, MEASURED — NOT GUESSED.
 *
 * The instruction is to set the deadline to a safe MULTIPLE of the device's check-in
 * cadence so a healthy device never flaps stale. Here is what the tree actually says about
 * that cadence:
 *
 *   1. THERE IS NO PERIODIC HEARTBEAT SCHEDULER in `packages/worker-daemon` — a source
 *      search for "heartbeat" across the daemon returns nothing. The shipped daemon has no
 *      dedicated timer that drives `POST /execution-targets/heartbeat`.
 *   2. `workers.lastSeenAt` is therefore advanced by exactly two paths:
 *        • the session-heartbeat endpoint (`heartbeatSessionProfile`), and
 *        • active lease work (`touchWorkerLeaseProfile`, on ack / renew / fence / events).
 *   3. The measurable cadences that DO exist:
 *        • the poll long-poll timeout `pollTimeoutMs` — default 30 s, MAX 600 s (10 min)
 *          (`packages/worker-daemon/src/config/config.ts`);
 *        • the worker SESSION TTL — 15 min ("10-min code route < 15-min session",
 *          `packages/worker-daemon/src/lease/lease-renewal.ts`), which bounds how often a
 *          device must re-establish (and thus re-advance liveness through) its session;
 *        • lease renewal, scheduled per-lease at `expiresAt − leadMs`.
 *
 * The slowest GUARANTEED refresh interval for a device that is actively checking in is the
 * 15-min session TTL (with a 10-min ceiling on idle poll reconnects). The default below —
 * 30 minutes — is 2× that session TTL and 3× the max poll timeout, so a device that only
 * refreshes on session / lease boundaries still reads `healthy` and never flaps. It is
 * deliberately generous rather than tight, exactly as instructed.
 *
 * Overridable via `AOA_DEVICE_LIVENESS_DEADLINE_MS` (see `resolveDeviceLivenessDeadlineMs`)
 * so an operator who ships a real periodic heartbeat can tighten it without a code change —
 * the same "change one argument at the composition root" discipline SVC-003b uses for its
 * own injectable deadline.
 */
export const DEVICE_LIVENESS_DEADLINE_MS_DEFAULT = 1_800_000; // 30 minutes

/** The env var an operator sets to override the deadline. */
export const DEVICE_LIVENESS_DEADLINE_ENV = "AOA_DEVICE_LIVENESS_DEADLINE_MS";

/**
 * Resolve the deadline from the environment, falling back to the conservative default.
 *
 * A present value must be a positive integer number of milliseconds; anything else
 * (empty, non-numeric, zero, negative, non-finite) is IGNORED in favour of the default
 * rather than silently disabling liveness. Kept separate from the pure classifier so the
 * classifier stays clock- and env-free and can be unit-tested with an injected deadline.
 */
export function resolveDeviceLivenessDeadlineMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[DEVICE_LIVENESS_DEADLINE_ENV]?.trim();
  if (!raw) return DEVICE_LIVENESS_DEADLINE_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEVICE_LIVENESS_DEADLINE_MS_DEFAULT;
  return parsed;
}

/**
 * The whole policy, as one pure function of three timestamps (`lastSeenAt`, `enrolledAt`,
 * `now`) and a deadline.
 *
 * `now` is INJECTED — the caller (`listDesktopDevices`) feeds it from the DATABASE clock
 * (`clock_timestamp()`), never `Date.now()`, so the classification cannot introduce
 * app/database clock skew and the row's `lastSeenAt` (a DB timestamp) is compared against a
 * DB-sourced `now`. Keeping the function pure is what lets the unit test drive every arm —
 * null, recent, exactly-at-deadline, old, and a pre-enrolment (re-enrolled) `lastSeenAt` —
 * with fabricated timestamps.
 */
export function classifyDeviceLiveness(input: {
  lastSeenAt: Date | null;
  enrolledAt: Date | null;
  now: Date;
  deadlineMs: number;
}): DeviceLivenessStatus {
  // ★ THE FAIL-OPEN ARM. No check-in has ever been recorded, so there is no liveness fact
  // to age. `never_seen`, and specifically NOT `stale`.
  if (input.lastSeenAt === null) return "never_seen";
  // ★ THE GENERATION BOUNDARY. A re-enrolment (`rotateWorker`) installs a NEW device key on
  // the SAME worker row — bumping `deviceGeneration` and `enrolledAt` — but PRESERVES the
  // prior generation's `lastSeenAt` (measured: `rotateWorker` never writes `lastSeenAt`). A
  // `lastSeenAt` that predates the current `enrolledAt` therefore belongs to a SUPERSEDED
  // key; the current generation has not checked in, so it is `never_seen`, never `healthy`
  // off its predecessor's heartbeat. This is the design's "compute liveness from
  // `lastSeenAt` AND the enrolment `deviceGeneration`, to flag silent re-enrolment". A null
  // `enrolledAt` (defensive — enrolled rows always carry one) skips the boundary and falls
  // through to age-based classification.
  if (input.enrolledAt !== null && input.lastSeenAt.getTime() < input.enrolledAt.getTime()) {
    return "never_seen";
  }
  const ageMs = input.now.getTime() - input.lastSeenAt.getTime();
  // ★ STRICT `>`: an age exactly equal to the deadline is still healthy. A future
  // `lastSeenAt` (negative age, e.g. mild clock skew) is likewise healthy, never stale.
  if (ageMs > input.deadlineMs) return "stale";
  return "healthy";
}
