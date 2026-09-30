/**
 * Sequenced worker-event production into an INJECTED sink (WRK-004).
 *
 * The supervisor emits `workerEventV1` records with CONTIGUOUS `seq` (each one
 * greater than the last) and a per-event `eventDigest` computed via the frozen
 * `canonicalEventDigestInputV1` + `node:crypto` SHA-256 — byte-identical to the
 * server's verifier. Events are handed to an injected {@link WorkerEventSink};
 * the durable outbox + `event_upload` wiring is WRK-006 (NOT in CORE).
 *
 * Every event is validated against the frozen `workerEventV1Schema` before it
 * leaves — a malformed payload or non-canonicalizable value fails HERE, never on
 * the wire.
 *
 * Runtime imports: `@armyofagents/worker-protocol` (frozen schema + canonical
 * digest) + `node:crypto` — the E4-D01 boundary.
 */

import { createHash, randomUUID } from "node:crypto";

import {
  canonicalEventDigestInputV1,
  workerEventV1Schema,
  type LogPayloadV1,
  type NetworkDeniedPayloadV1,
  type ProgressPayloadV1,
  type ServiceHealthPayloadV1,
  type TerminalEventStatus,
  type UsagePayloadV1,
  type WorkerEventType,
  type WorkerEventV1,
} from "@armyofagents/worker-protocol";

import { scrubEventStrings } from "./redaction.js";

/** The four frozen network-denial destination classes (`NETWORK_DENIAL_CLASSES`). */
export type NetworkDenialClass = NetworkDeniedPayloadV1["destinationClass"];

/** The two frozen `service_health` verdicts (`SERVICE_HEALTH_STATUSES`). */
export type ServiceHealthStatus = ServiceHealthPayloadV1["status"];

/**
 * SVC-008b — the identity every frozen service event repeats verbatim
 * (`serviceInstanceRefShape`, `worker-protocol/src/events.ts`).
 *
 * Held as plain strings/number on this side: the frozen ids are BRANDED zod types and the
 * schema parse in `#emit` is what re-establishes the brand. Widening to `string` here would
 * be unsafe if the parse were skipped — it is not: every emitter goes through `#emit`, which
 * parses the COMPLETE event against `workerEventV1Schema` before it leaves.
 */
export interface ServiceInstanceRef {
  readonly serviceId: string;
  readonly serviceInstanceId: string;
  readonly generation: number;
}

function serviceRef(ref: ServiceInstanceRef): { serviceId: string; serviceInstanceId: string; generation: number } {
  return { serviceId: ref.serviceId, serviceInstanceId: ref.serviceInstanceId, generation: ref.generation };
}

/** The delivery identity every event under a lease repeats verbatim. */
export interface EventDeliveryIdentity {
  readonly organizationId: string;
  readonly companyId: string;
  readonly workerId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly leaseId: string;
  readonly fenceToken: string;
}

/** The injected destination for sequenced events (durable upload = WRK-006). */
export interface WorkerEventSink {
  emit(event: WorkerEventV1): Promise<void> | void;
}

export interface EventSequencerDeps {
  readonly identity: EventDeliveryIdentity;
  readonly sink: WorkerEventSink;
  /** Injectable id/clock for deterministic tests. */
  readonly newEventId?: () => string;
  readonly now?: () => string;
  /** DAT-005 D4 — the PER-RUN secret canaries. Every string in every emitted event
   * is scrubbed of these substrings BEFORE the digest (so the durable outbox can
   * never seal a value). Passed explicitly per run — never a module singleton — to
   * avoid cross-run bleed. An empty array = no redaction (verbatim emit).
   *
   * REQUIRED (never optional): every construction site must make a deliberate choice
   * so a sequencer can never be built unscrubbed by omission — the exact defect that
   * left the supervisor's primary lifecycle stream unredacted while only the
   * fence-close denial stream was scrubbed. Pass `[]` to opt out explicitly. */
  readonly redactionCanaries: readonly string[];
}

/** lowercase-hex SHA-256 over the canonical event bytes. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Truncate to at most `max` UTF-16 code units WITHOUT bisecting a surrogate pair.
 * A raw `slice(0, max)` can leave a trailing lone high surrogate, which the canonical
 * digest (`canonicalizeString`) rejects BEFORE the schema parse — dropping the event
 * (and, because the supervisor emits log/progress/usage under one try, the run's
 * trailing usage evidence too). If truncation lands on a high surrogate, drop it.
 */
function truncateUtf16Safe(text: string, max: number): string {
  if (text.length <= max) return text;
  const sliced = text.slice(0, max);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * Produces contiguous, digest-stamped, schema-valid worker events into the sink.
 * One sequencer per lease/attempt; `seq` starts at 1 and increments by exactly 1.
 */
export class EventSequencer {
  readonly #identity: EventDeliveryIdentity;
  readonly #sink: WorkerEventSink;
  readonly #newEventId: () => string;
  readonly #now: () => string;
  readonly #canaries: readonly string[];
  #seq = 0;

  constructor(deps: EventSequencerDeps) {
    this.#identity = deps.identity;
    this.#sink = deps.sink;
    this.#newEventId = deps.newEventId ?? randomUUID;
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#canaries = deps.redactionCanaries ?? [];
  }

  /** The seq the NEXT emitted event will carry. */
  nextSeq(): number {
    return this.#seq + 1;
  }

  async #emit(eventType: WorkerEventType, payload: unknown, extensions: readonly unknown[] = []): Promise<WorkerEventV1> {
    this.#seq += 1;
    const withoutDigest = {
      protocolVersion: 1 as const,
      eventId: this.#newEventId(),
      organizationId: this.#identity.organizationId,
      companyId: this.#identity.companyId,
      workerId: this.#identity.workerId,
      jobId: this.#identity.jobId,
      attempt: this.#identity.attempt,
      leaseId: this.#identity.leaseId,
      fenceToken: this.#identity.fenceToken,
      seq: this.#seq,
      occurredAt: this.#now(),
      extensions,
      eventType,
      payload,
    };
    // DAT-005 D4 — scrub per-run secret canaries from EVERY string BEFORE the digest,
    // so the digest + parse below cover the scrubbed bytes and the durable outbox
    // (which seals verbatim + never re-digests) can never persist a value.
    const scrubbed = scrubEventStrings(withoutDigest, this.#canaries);
    const eventDigest = sha256Hex(canonicalEventDigestInputV1(scrubbed));
    // Parse the COMPLETE event (contiguity + shape + forbidden-key scan) before
    // it leaves — a contract failure surfaces here, not on the wire.
    const event = workerEventV1Schema.parse({ ...scrubbed, eventDigest });
    await this.#sink.emit(event);
    return event;
  }

  /** `attempt_started` — the sandbox is up and the tenant command is running
   * inside it. */
  attemptStarted(sandboxId: string): Promise<WorkerEventV1> {
    return this.#emit("attempt_started", { sandboxId });
  }

  /** `network_denied` — a governed egress attempt was refused. WRK-005's
   * fence-close proxy emits this (the positive counterpart of the
   * `CleanupAuthority.openEgress` hard denial) when an egress is attempted after
   * the fence has closed. */
  networkDenied(input: { destinationClass: NetworkDenialClass; reason: string }): Promise<WorkerEventV1> {
    return this.#emit("network_denied", { destinationClass: input.destinationClass, reason: input.reason });
  }

  /** `log` — a captured stdout/stderr/system output chunk from the sandbox run
   * (CLI-003/D2). The message is TRUNCATED to the frozen 65536-char ceiling so an
   * over-long chunk can never fail the parse; scrubbing + digest run in `#emit`. */
  log(input: { stream: LogPayloadV1["stream"]; level: LogPayloadV1["level"]; message: string }): Promise<WorkerEventV1> {
    const message = truncateUtf16Safe(input.message, 65_536);
    return this.#emit("log", { stream: input.stream, level: input.level, message });
  }

  /** `progress` — a bounded progress tick (CLI-003/D2). `percent` is an INTEGER
   * 0–100 or null (indeterminate); `message` is truncated to the frozen 2000-char
   * ceiling. */
  progress(input: { message: string; percent: ProgressPayloadV1["percent"] }): Promise<WorkerEventV1> {
    const message = truncateUtf16Safe(input.message, 2000);
    return this.#emit("progress", { message, percent: input.percent });
  }

  /** `usage` — bounded, EVIDENTIARY-ONLY token/runtime metering (CLI-003/D2/D5).
   * The FROZEN `usagePayloadV1Schema` is `.strict()`, so a cost/price/provider/model
   * field would fail the parse in `#emit`: CLI-003 emits evidence, JOB-012 prices. */
  usage(input: UsagePayloadV1): Promise<WorkerEventV1> {
    return this.#emit("usage", {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedInputTokens: input.cachedInputTokens,
      runtimeMillis: input.runtimeMillis,
    });
  }


  /**
   * `browser_observation` — BRW-003d-3.
   *
   * ★ DORMANT, and labelled so — but NOT for the reason originally written here.
   * `createSupervisor` does have a production caller (`lifecycle/dispatch-runtime.ts`,
   * which says so itself), so that clause was false. What is still dormant is THIS
   * METHOD: `browserObservation` has no caller outside its own tests, so nothing emits
   * the event yet. It is the API the browser runtime will use and a FORWARD GUARD,
   * never a clause's proof.
   *
   * The FROZEN payload is `.strict()` with exactly three fields — artifactIds, url,
   * title. Console lines and network summaries have nowhere else to go, so they
   * ride `extensions`, which `#emit` now carries. Two properties come for free
   * there and are worth stating: extensions are inside the canary scrub AND inside
   * the digest, because both run over the whole event.
   *
   * Callers must pass INTEGERS. `canonical-json` rejects a float outright
   * ("float is not allowed in the v1 subset"), and the parse in `#emit` runs before
   * the wire — so an un-quantised duration fails the emit rather than rounding
   * silently. Use `quantiseExtensionNumbers` on anything float-native.
   */
  browserObservation(input: {
    artifactIds: readonly string[];
    url: string | null;
    title: string | null;
    extensions?: readonly unknown[];
  }): Promise<WorkerEventV1> {
    return this.#emit(
      "browser_observation",
      { artifactIds: [...input.artifactIds], url: input.url, title: input.title },
      input.extensions ?? [],
    );
  }

  // --- SVC-008b: the service-instance events -----------------------------------
  //
  // ★★★ THE ONE RULE THESE FIVE OBEY (SVC-008 §3.1a). An event may assert ONLY what an op
  // the daemon actually called returned. A sandbox-scoped answer may not be reported as a
  // process-scoped fact. That rule lives in `service-lifecycle.ts` (which decides WHEN each
  // of these is called); the docstrings here restate the precondition so a future caller
  // cannot reach for one without meeting it.
  //
  // ★ There is deliberately NO emitter for `service_checkpoint_prepared` / `_restored`
  // (SVC-004 owns checkpoint policy, and an emitter with no policy is a scope leak) and
  // NONE for `service_provider_interrupted` / `_resumed`. The latter is NOT an oversight:
  // §4.4 names `inspect` reporting the sandbox "suspended and then live again" as the
  // witness, and `SandboxState` (`provider.ts`) has no suspended/paused inhabitant —
  // creating/running/cancelling/stopped/destroyed/failed. Adding the emitter would hand a
  // caller a durable claim nothing in this tree can witness, which is §1.3(c) one event over.

  /**
   * `service_instance_started` — asserts **`starting`** and NOTHING about the process.
   *
   * PRECONDITION: `create` resolved `providerResourceId` (a SANDBOX id — the frozen payload
   * names a provider resource, not a process) AND a launch has been requested on it. It is
   * NOT a claim that the process is up; that claim is `service_health`, and it needs a
   * process-scoped witness.
   */
  serviceInstanceStarted(input: ServiceInstanceRef & { providerResourceId: string }): Promise<WorkerEventV1> {
    return this.#emit("service_instance_started", { ...serviceRef(input), providerResourceId: input.providerResourceId });
  }

  /**
   * `service_health` — the provider's verdict about the SUPERVISED PROCESS, verbatim.
   *
   * PRECONDITION: `processSupervisionMode !== "none"` and the verdict came from a
   * `processStatus` read of the run's handle. ★ The frozen optional `health` op may NOT
   * source this: it answers `sandbox.isRunning()`, and a sandbox is up from the moment
   * `create` resolves, so it would report `healthy` for a process that never started.
   * A verdict that could not be read is NOT an event — emit nothing.
   */
  serviceHealth(input: ServiceInstanceRef & { status: ServiceHealthStatus; detail: string | null }): Promise<WorkerEventV1> {
    return this.#emit("service_health", { ...serviceRef(input), status: input.status, detail: input.detail });
  }

  /** `service_graceful_stop_observed` — observes the stop REQUEST and its deadline. Honest
   * either way: the payload is only `{ref, deadline}` and claims nothing about the process. */
  serviceGracefulStopObserved(input: ServiceInstanceRef & { deadline: string }): Promise<WorkerEventV1> {
    return this.#emit("service_graceful_stop_observed", { ...serviceRef(input), deadline: input.deadline });
  }

  /**
   * `service_instance_stopped` — the process was OBSERVED gone.
   *
   * PRECONDITION: a `processStatus` observation of `exited` or `gone`. ★ NEVER on a stop
   * request, and never on a signal's return value: `ProcessSignalResult.accepted` describes
   * the CALL, and real E2B accepts a signal that stops nothing (E7-F034).
   */
  serviceInstanceStopped(input: ServiceInstanceRef & { exitCode: number | null }): Promise<WorkerEventV1> {
    return this.#emit("service_instance_stopped", { ...serviceRef(input), exitCode: input.exitCode });
  }

  /** `service_instance_lost` — the instance can no longer be accounted for: the sandbox is
   * gone, or a stop ladder ran to its end with the process still observed running. */
  serviceInstanceLost(input: ServiceInstanceRef & { reason: string }): Promise<WorkerEventV1> {
    return this.#emit("service_instance_lost", { ...serviceRef(input), reason: truncateUtf16Safe(input.reason, 1000) });
  }

  /** The terminal attempt event (succeeded/failed/cancelled/expired). */
  terminal(input: {
    status: TerminalEventStatus;
    exitCode: number | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<WorkerEventV1> {
    return this.#emit("terminal", {
      status: input.status,
      exitCode: input.exitCode,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
    });
  }
}

/**
 * Round every non-integer number in a wire-extension value to an integer.
 *
 * ★ WHY THIS IS NOT OPTIONAL SUGAR. A browser network summary is float-native —
 * durations, timings, transfer rates — and the v1 canonical-JSON subset REJECTS
 * floats outright. The failure mode is therefore a REJECTED EVENT, not a rounded
 * number: the whole observation is lost, at emit time, for one fractional
 * millisecond. Quantising at the boundary is what keeps the frozen constraint from
 * turning ordinary telemetry into dropped evidence.
 *
 * Non-finite numbers (NaN, Infinity) are refused rather than coerced: they are a
 * producer bug, and silently turning one into 0 would bury it in the data.
 */
export function quantiseExtensionNumbers<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        throw new RangeError(`non-finite number cannot be quantised: ${String(node)}`);
      }
      return Math.round(node);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object" && Object.getPrototypeOf(node) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(value) as T;
}
