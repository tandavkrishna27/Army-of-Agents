/**
 * Bounded-label metrics surface (WRK-001).
 *
 * Stable metrics use bounded labels ONLY (`operation`, `outcome`/`reason`,
 * `workload`, `provider`, `escalation_stage`) — never `organizationId`,
 * `companyId`, `jobId`, event content, secret, key, or session bytes. The
 * counter map is validated against a closed label-KEY allow-list AND a bounded
 * label-VALUE token, so a caller cannot widen cardinality or smuggle tenant
 * identity (an id/UUID/free-form string) into `/metrics` as a label value.
 * WRK-003/004 that add poll/lease/cleanup counters must register the closed
 * value set for each key here; the token bound below is the interim floor.
 */

export const ALLOWED_LABEL_KEYS = new Set([
  "operation",
  "outcome",
  "reason",
  "workload",
  "provider",
  "escalation_stage",
  // WRK-003: backoff-sleep histogram bucket (a CLOSED token set, below).
  "bucket",
  // WRK-005: the governed-effect a fence-close proxy denied (a CLOSED token set,
  // below) — the four exit-gate governed effects, never a free-form string.
  "effect",
]);

// -----------------------------------------------------------------------------
// WRK-004 sandbox-supervisor metric NAMES.
//
// The observable-signals contract names `sandbox_op{op,outcome}`,
// `cleanup_outcome{status}`, `cleanup_escalation{stage}`, and
// `reconcile_orphans_total`. To keep label-KEY cardinality inside the closed
// allow-list already registered above (this module pre-declared `operation`,
// `outcome`, and `escalation_stage` for exactly this ticket), the supervisor
// carries the sandbox op name under the existing `operation` key, the op/cleanup
// disposition under `outcome`, and the escalation rung under `escalation_stage`
// — NOT new `op`/`status`/`stage` keys. Each of those keys has a CLOSED value set
// below, so the series space stays provably finite and NO command/env/secret/
// byte/id content can enter a metric as a key OR value (E4 metrics contract;
// resourceLabels are HASHED and never labeled).
// -----------------------------------------------------------------------------
export const SANDBOX_OP_METRIC = "sandbox_op";
export const CLEANUP_OUTCOME_METRIC = "cleanup_outcome";
export const CLEANUP_ESCALATION_METRIC = "cleanup_escalation";
export const RECONCILE_ORPHANS_METRIC = "reconcile_orphans_total";

// -----------------------------------------------------------------------------
// WRK-005 lease-renewal / fence-close-proxy / quarantine metric NAMES.
//
// `lease_renew{outcome}` (renewed/cancel_requested/rejected/recovered + shared
// error tokens), `lease_loss{reason}` and `fence_close{reason}` (local reason
// tokens via the `reason` floor), `governed_effect_denied{effect}` (the CLOSED
// four-effect set), and `quarantine{outcome}` (granted/quarantined/dropped/
// rejected + shared error tokens). Every label value stays inside the closed
// per-key allow-lists below — no id/lease/secret byte can enter as a label.
// -----------------------------------------------------------------------------
export const LEASE_RENEW_METRIC = "lease_renew";
export const LEASE_LOSS_METRIC = "lease_loss";
export const FENCE_CLOSE_METRIC = "fence_close";
export const GOVERNED_EFFECT_DENIED_METRIC = "governed_effect_denied";
export const QUARANTINE_METRIC = "quarantine";
/** JOB-015 — `control_command{outcome}`: one line per delivered control command
 * (applied / deferred / gap / conflict / stale / oversized / unhandled). The counter
 * that answers "did the command actually reach a handler?", which is the only question
 * this ticket's acceptance turns on — a command appearing in a payload is not delivery. */
export const CONTROL_COMMAND_METRIC = "control_command";

/**
 * A bounded low-cardinality enum token: lowercase, starts with a letter, at most
 * 40 chars of [a-z0-9_]. Rejects UUIDs (hyphens/mixed case), long free-form
 * strings, and most identifiers — the floor for keys that do NOT yet have a
 * closed value allow-list.
 */
const LABEL_VALUE_TOKEN = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * CLOSED per-key value allow-lists (E4 metrics contract: "WRK-003/004 that add
 * poll/lease/cleanup counters must register the closed value set for each key").
 * A key WITH a closed set admits ONLY those values; a key WITHOUT one still falls
 * back to the `LABEL_VALUE_TOKEN` floor. This makes the poll/lease/backoff label
 * cardinality provably finite — a caller cannot smuggle an identifier or widen
 * the series space through `outcome`/`workload`/`bucket`.
 */
export const CLOSED_LABEL_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  operation: new Set([
    // WRK-004 provider ops (the frozen PROVIDER_OPERATIONS vocabulary).
    "create",
    "execute",
    "cancel",
    "kill",
    "destroy",
    "list",
    "inspect",
    "reconcile_cleanup",
    "checkpoint",
    "restore",
    "health",
    // ★ CLI-008 Unit B — `stage_files` is NOT a `PROVIDER_OPERATIONS` member and never will be.
    // It is a method on the NON-FROZEN supervisor port (that was the Unit B decision: grow the
    // port, leave the wire vocabulary alone), so it does not arrive here with the eleven above
    // and has to be registered deliberately. Without this entry `emitOp("stage_files", …)`
    // THROWS on the closed allow-list — on the success path as readily as the failure path —
    // and the throw lands in `accept`'s last-resort catch, which emits NO TERMINAL. A staged run
    // would be torn down and stranded non-terminal, which is the exact outcome the staging arms'
    // fail-closed handling exists to prevent.
    "stage_files",
    // ★ DAT-009 slice 3 — `digest_artifact` and `export_artifact` are in EXACTLY the position
    // `stage_files` was in, and are registered here for exactly the reason above. They are
    // methods on the NON-FROZEN supervisor port (DAT-009 slice 1 grew the port and left the
    // wire vocabulary alone — the same decision Unit B made), so they do not arrive with the
    // eleven frozen ops and nothing adds them for you.
    //
    // Registered in the SLICE THAT ADDS THE METHODS TO `EffectAuthority`, not in the later
    // slice that first calls `emitOp` with them. Two lines whose absence is a run stranded
    // with NO TERMINAL on the happy path (E7-F010) are not a thing to leave for a later PR,
    // and by then the omission is invisible: the throw happens inside the fail-closed arms,
    // so the failure arm re-throws from its own emit and the escape lands in `accept()`'s
    // last-resort catch, which emits nothing at all.
    "digest_artifact",
    "export_artifact",
  ]),
  outcome: new Set([
    // poll outcomes
    "offer",
    "no_work",
    "drain",
    // REL-004 clause 3a — a drain carrying `retryAfterMs` is a reversible PAUSE, not a stop.
    // Kept as its own value because "the fleet is paused" and "the fleet shut down" is the one
    // question an operator asks during a kill, and one shared label cannot answer it.
    "drain_paused",
    "incompatible",
    "backpressure",
    "recovered",
    // WRK-005 lease_renew + quarantine outcomes.
    "renewed",
    "cancel_requested",
    "granted",
    "quarantined",
    "dropped",
    // an offer that arrived after lease-stop began (drain-before-lease-stop) →
    // dropped un-ACKed rather than abandoned in flight at exit.
    "offer_dropped",
    // shared error/terminal outcomes
    "malformed",
    "unauthorized",
    "reenrollment_required",
    "target_revoked",
    "throttled",
    "internal_unavailable",
    "timeout",
    "socket_error",
    // lease_ack outcomes
    "acknowledged",
    "rejected",
    "handed_off",
    // WRK-004 sandbox-op + cleanup outcomes.
    "success",
    "failed",
    "timed_out",
    "denied",
    "unsupported",
    "ignored",
    "stopped",
    // DEP-011 Slice 2a — the HONEST-cleanup orphan outcome (Option A): a live tenant
    // sandbox the worker could NOT tear down because its lease-clamped capability
    // expired. DISTINCT from BOTH `success` (never mask a live strand) AND `failed`
    // (a failed teardown attempt) — it is the leak-rate signal the deferred
    // server-side reaper consumes. A CLOSED value, registered here (the metrics
    // `outcome` key is a closed allow-list — DEP-011 §2a.11 records this as a
    // build deviation from the design's "open string" wording).
    "orphaned",
    // ★★★ JOB-015 — the control-command delivery outcomes, registered in the SAME
    // commit that first emits them. `outcome` is a CLOSED allow-list: an unregistered
    // value THROWS, and it throws on the HAPPY path (a delivered command) as readily as
    // on a failure. In the renewal driver that throw would land in the renew loop's
    // error handling, so a run could be torn down with NO TERMINAL — the E7-F010 shape,
    // where growing the non-frozen port left a structure DERIVED from the frozen
    // vocabulary behind and nothing added the entry. `CLOSED_LABEL_VALUES.outcome` (and
    // its `packages/worker-daemon/src/index.ts` re-export) is the only structure derived
    // from this vocabulary in the repo; that was enumerated before these lines were added.
    "applied",
    "deferred",
    "gap",
    "conflict",
    "stale",
    "oversized",
    "unhandled",
    // ★★★ Wave-4 — the periodic heartbeat driver's `heartbeat_outcome` values, registered in the
    // SAME commit that first emits them (poll/heartbeat-loop.ts). `outcome` is a CLOSED allow-list:
    // an unregistered value THROWS in `inc`, and it throws on the HAPPY path (a 204 beat) as readily
    // as on failure — which, in the fire-and-forget heartbeat loop, would orphan the rejection AND
    // leave `firstBeat` unresolved so the poll loop never starts (the exact bug the heartbeat fixes).
    // "failed" is already registered above (shared with sandbox/cleanup); these three are new.
    "ok",
    "terminal",
    "session_unavailable",
  ]),
  workload: new Set(["batch", "browser_session", "service"]),
  bucket: new Set(["lt_1s", "lt_5s", "lt_30s", "gte_30s"]),
  // WRK-004 escalation ladder rungs.
  escalation_stage: new Set(["none", "cancel", "kill", "destroy"]),
  // WRK-005 governed-effect surface (mirror of the server GOVERNED_FENCE_SURFACE).
  effect: new Set(["artifact_commit", "secret_materialization", "task_completion", "governed_egress"]),
};

export interface Metrics {
  /** Liveness gauge exposed as `worker_up`. */
  setWorkerUp(up: boolean): void;
  /** Increment a bounded counter; unknown label keys / values throw. */
  inc(name: string, labels?: Readonly<Record<string, string>>, by?: number): void;
  /** Set a bounded labeled gauge (last-write-wins) — e.g. `active_leases`,
   * `capacity_free_slots{workload}`. */
  setGauge(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
  /** Render the current gauges + counters as Prometheus text exposition. */
  renderPrometheus(): string;
}

/** A metric-line label key/value that fails validation is rejected, never logged. */
function assertBoundedLabels(labels: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(labels)) {
    if (!ALLOWED_LABEL_KEYS.has(key)) {
      throw new Error(
        `metric label key ${JSON.stringify(key)} is not in the bounded allow-list ` +
          `(${[...ALLOWED_LABEL_KEYS].join(", ")})`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(`metric label ${JSON.stringify(key)} value must be a string`);
    }
    const closed = CLOSED_LABEL_VALUES[key];
    if (closed !== undefined) {
      if (!closed.has(value)) {
        // Never echo the offending value — it may be the very identity we reject.
        throw new Error(
          `metric label ${JSON.stringify(key)} has an unregistered value; ` +
            "labels carry values from the closed per-key allow-list only",
        );
      }
    } else if (!LABEL_VALUE_TOKEN.test(value)) {
      throw new Error(
        `metric label ${JSON.stringify(key)} has an unbounded/non-token value; ` +
          "labels carry low-cardinality enum tokens only, never identifiers",
      );
    }
  }
}

/** Render a stable, order-independent key for a metric + its labels. */
function seriesKey(name: string, labels: Readonly<Record<string, string>>): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`);
  return parts.length > 0 ? `${name}{${parts.join(",")}}` : name;
}

export function createMetrics(): Metrics {
  let workerUp = 0;
  const counters = new Map<string, number>();
  const gauges = new Map<string, number>();

  return {
    setWorkerUp(up: boolean): void {
      workerUp = up ? 1 : 0;
    },
    inc(name: string, labels: Readonly<Record<string, string>> = {}, by = 1): void {
      assertBoundedLabels(labels);
      const key = seriesKey(name, labels);
      counters.set(key, (counters.get(key) ?? 0) + by);
    },
    setGauge(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
      assertBoundedLabels(labels);
      gauges.set(seriesKey(name, labels), value);
    },
    renderPrometheus(): string {
      const lines: string[] = [];
      lines.push("# HELP worker_up 1 when the worker process is live.");
      lines.push("# TYPE worker_up gauge");
      lines.push(`worker_up ${workerUp}`);
      for (const [key, value] of [...gauges.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`${key} ${value}`);
      }
      for (const [key, value] of [...counters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`${key} ${value}`);
      }
      return `${lines.join("\n")}\n`;
    },
  };
}
