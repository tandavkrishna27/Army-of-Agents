// WRK-008 slice 2b — the dispatch runtime: compose the poll loop, supervisor, lease-renewal
// driver and durable event outbox from a provisioned self-model + a live session lifecycle.
//
// This is the FIRST production caller of `createPollLoop` and `createSupervisor` in the
// programme's history. It runs ONLY inside the `compose: true` branch of the boot (Step 7),
// i.e. behind the default-OFF flag with a provider injected, a device identity, an outbox
// path, a live session and an admin-set placement profile.
//
// ★ ORDER IS LOAD-BEARING, and four edges are not obvious:
//   1. The outbox store opens FIRST and is RECOVERED (uploading→pending) before anything can
//      emit into it. Recovering after the supervisor exists would race a fresh run's rows.
//   2. The poll loop's `supervisor` seam is the RENEWAL DRIVER, not the supervisor. The driver
//      decorates the real supervisor; wiring the raw supervisor typechecks and silently never
//      renews a lease.
//   3. The SAME `DurableWorkerEventSink` goes to BOTH the supervisor AND the driver. The
//      driver's `eventSink` is optional and defaults to NOOP_SINK, so omitting it silently
//      drops the post-close `network_denied` evidence stream — a fail-open (§4.1.1).
//   4. The KEK derives from the DEVICE KEY, so a re-enrolled device cannot open a prior
//      device's rows (they quarantine, fail closed).

import {
  measureCapacity,
  type CapacityProbes,
  type CapacityReservation,
  type WorkerSelfModel,
} from "../poll/capacity.js";
import {
  createPollLoop,
  createSessionProvider,
  type LeaseHandoff,
  type PollLoopController,
  type SessionProvider,
  type SupervisorSeam,
} from "../poll/poll-loop.js";
import { ConcurrencyLimiter } from "../poll/concurrency.js";
import { createHostCapacityProbes, defaultHostProbeReaders } from "../poll/host-probes.js";
import { createSupervisor } from "../supervisor/supervisor.js";
import { createRunCanaryCoordinator } from "../supervisor/run-canaries.js";
import { resolveRunOpDeadlineMs } from "./run-op-deadline.js";
import { createRedeemer, synthesiseRunSecrets } from "../lease/secret-redemption.js";
import { createStagedInputResolver } from "../lease/staged-input.js";
import { createLeaseRenewalDriver, createRealRenewalSchedule } from "../lease/lease-renewal.js";
import { openEventOutboxStore, type DurableEventStore } from "../events/event-outbox-store.js";
import { DurableWorkerEventSink } from "../events/durable-event-sink.js";
import { createEventOutboxDrain } from "../events/event-outbox-drain.js";
import { deriveKekFromDeviceKey } from "../events/event-outbox-kek.js";
import type { SandboxProvider } from "../supervisor/provider.js";
import type { OwnedLabelsCapabilityLike } from "../lease/owned-labels-capability.js";
import type { DeviceKey } from "../identity/device-key.js";
import type { SessionStore } from "../identity/session.js";
import type { ControlPlaneClient } from "../transport/client.js";
import type { BackoffConfig } from "../poll/backoff.js";
import type { Logger } from "../logging/logger.js";
import type { Metrics } from "../metrics/metrics.js";
import type {
  EventOutboxLifecycle,
  LeasingLifecycle,
  RenewalLifecycle,
} from "./shutdown.js";

const NO_RESERVATION: CapacityReservation = { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 };

export interface ComposeDispatchRuntimeDeps {
  /**
   * The DESKTOP/in-process provider. OPTIONAL since DEP-011 Slice 2a: a CONTAINER worker instead
   * injects `makeRunProvider` (a per-run networked driver factory). EXACTLY one of
   * `provider`/`makeRunProvider` is set — the supervisor fail-fasts on both, and the boot's
   * `decideDispatchComposition`/`shouldComposeSession` gate `!provider && !makeRunProvider ⇒
   * no_provider`.
   */
  readonly provider?: SandboxProvider;
  /** DEP-011 Slice 2a — the per-run networked provider FACTORY (a TYPE here; the impl comes from the
   * outside composition root, Slice 2b). Passed through to the supervisor, which builds a per-run
   * driver over the run's minted capability AFTER redemption. */
  readonly makeRunProvider?: (input: { handoff: LeaseHandoff; capability?: OwnedLabelsCapabilityLike }) => SandboxProvider;
  /** The PROVISIONED self-model (matchable): its `report` is the provisioned hello. */
  readonly self: WorkerSelfModel;
  readonly key: DeviceKey;
  /** Sprint 2.5's session store (this slice threads it in; it does NOT construct one). */
  readonly store: SessionStore;
  readonly client: ControlPlaneClient;
  readonly eventOutboxPath: string;
  readonly concurrency: { readonly batch: number; readonly browser: number; readonly service: number };
  readonly backoff: BackoffConfig;
  /** Directory the disk-free probe reads (the worker's working area). */
  readonly workDir: string;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  // --- test seams: default to the real factories -------------------------------------------
  /** The host capacity probes; defaults to the real node:os/node:fs readers over `workDir`. */
  readonly probes?: CapacityProbes;
  readonly openStore?: typeof openEventOutboxStore;
  readonly makeSink?: (deps: { store: DurableEventStore; kek: Buffer }) => DurableWorkerEventSink;
  readonly makeDrain?: typeof createEventOutboxDrain;
  readonly makeSupervisor?: typeof createSupervisor;
  readonly makeDriver?: typeof createLeaseRenewalDriver;
  readonly makePollLoop?: typeof createPollLoop;
  readonly makeSchedule?: typeof createRealRenewalSchedule;
}

export interface DispatchRuntime {
  readonly leasing: LeasingLifecycle;
  readonly renewal: RenewalLifecycle;
  readonly eventOutbox: EventOutboxLifecycle;
  readonly self: WorkerSelfModel;
  /** The measured capacity closure — reads the limiter LIVE and clamps to the provider ceiling. */
  readonly measure: () => ReturnType<typeof measureCapacity>;
  /** The seam the poll loop leases through — the renewal DRIVER (a SupervisorSeam), not the raw supervisor. */
  readonly loopSupervisorSeam: SupervisorSeam;
  /** The concurrency limiter (backpressure); exposed so `measure()`'s LIVE read is observable. */
  readonly limiter: ConcurrencyLimiter;
  /** Start the durable drain loop and the poll loop (fire-and-forget: a terminal stop does not exit). */
  start(): void;
  readonly pollLoop: PollLoopController;
}

export async function composeDispatchRuntime(deps: ComposeDispatchRuntimeDeps): Promise<DispatchRuntime> {
  const openStore = deps.openStore ?? openEventOutboxStore;
  const makeSink = deps.makeSink ?? ((d) => new DurableWorkerEventSink(d));
  const makeDrain = deps.makeDrain ?? createEventOutboxDrain;
  const makeSupervisor = deps.makeSupervisor ?? createSupervisor;
  const makeDriver = deps.makeDriver ?? createLeaseRenewalDriver;
  const makePollLoop = deps.makePollLoop ?? createPollLoop;
  const makeSchedule = deps.makeSchedule ?? createRealRenewalSchedule;

  const session: SessionProvider = createSessionProvider(deps.store);
  const identity = {
    targetId: deps.self.report.targetId,
    deviceGeneration: deps.self.report.deviceGeneration,
  };

  // (1) Store opens FIRST. (4) KEK from the DEVICE KEY. (3) ONE sink instance for both consumers.
  const store = await openStore({ path: deps.eventOutboxPath });
  const kek = deriveKekFromDeviceKey(deps.key);
  const eventSink = makeSink({ store, kek });
  const drain = makeDrain({ store, client: deps.client, session, key: deps.key, kek, logger: deps.logger });

  // (1) RECOVER before the supervisor can emit into the store.
  drain.recover();

  // DAT-008 slice 5 — the per-lease canary coordinator, shared by the supervisor and the driver's
  // fence-close proxy so ONE redemption seeds BOTH event streams (per-run, before create).
  const canaryCoordinator = createRunCanaryCoordinator();

  // DAT-008 slice 5 — per-run secret materialisation: redeem the envelope's `env`/`sandbox_local_only`
  // handles via the LOCAL resolve route (device proof + the live session), synthesise the sandbox
  // env, and return the redeemed values to seed as canaries. Fails CLOSED inside the supervisor.
  const materializeRunSecrets = async (
    handoff: LeaseHandoff,
  ): Promise<{ env: Record<string, string>; canaries: readonly string[]; capability?: OwnedLabelsCapabilityLike }> => {
    const workerSession = await session.get();
    const redeem = createRedeemer({
      client: deps.client,
      key: deps.key,
      session: workerSession,
      fence: {
        workerId: String(handoff.offer.workerId),
        jobId: String(handoff.offer.job.jobId),
        attempt: handoff.offer.job.attempt,
        leaseId: handoff.leaseId,
        fenceToken: String(handoff.fenceToken),
      },
    });
    return synthesiseRunSecrets(handoff.offer.job.secretHandles ?? [], redeem);
  };

  // CLI-008 Unit B — per-run staged input: read the control plane's pointer off the frozen
  // envelope and mint ONE short-lived download grant per file. Grants out, never bytes; the
  // provider redeems them. A run whose envelope carries no pointer resolves to `[]` and the
  // lifecycle is byte-identical to before, which is what keeps staging optional. Fails CLOSED
  // inside the supervisor.
  const resolveStagedFiles = createStagedInputResolver({
    client: deps.client,
    key: deps.key,
    session: () => session.get(),
  });

  // `redactionCanaries: []` is the construction-time PREFIX; the run's real canaries are seeded
  // PER-RUN into the coordinator's per-lease array (below), never at construction — so no
  // construction-time secret exists and a forgotten seeding cannot fail open. observeRun stays
  // absent (no sandbox stdout/stderr rides the stream yet), but the redeemed provider key does now
  // transit the supervisor transiently, which is exactly what the per-run canaries scrub.
  // DEP-011 Slice 2a — pass EXACTLY the injected provider path through to the supervisor: the
  // DESKTOP `provider` OR the container `makeRunProvider` (the supervisor fail-fasts if both, and
  // the boot gate refuses if neither). `materializeRunSecrets` is always present here, so the
  // makeRunProvider⟹materializeRunSecrets pairing (supervisor fail-fast F5) is satisfied.
  const supervisor = makeSupervisor({
    provider: deps.provider,
    makeRunProvider: deps.makeRunProvider,
    identity,
    eventSink,
    redactionCanaries: [],
    materializeRunSecrets,
    resolveStagedFiles,
    canaryCoordinator,
    // ★ H1 — the run's OWN budget, from `workload.maxRuntimeSeconds`. Before this the
    // supervisor's 60 s default stood for every run, and that one number is simultaneously
    // the execute race, the E2B sandbox TTL, and the E2B command timeout — so every task
    // needing more than a minute was killed and terminalized `failed` while its declared
    // budget was ignored. `resolveRunOpDeadlineMs` keeps the value inside the owned-labels
    // capability window (which is never re-minted on renewal): running past it would leave a
    // BILLABLE sandbox the worker can no longer tear down, recorded `orphaned`.
    opDeadlineMs: resolveRunOpDeadlineMs,
    logger: deps.logger,
    metrics: deps.metrics,
  });

  // (3) SAME eventSink. `schedule` is REQUIRED and has no default.
  const driver = makeDriver({
    client: deps.client,
    session,
    key: deps.key,
    identity,
    supervisor,
    schedule: makeSchedule(),
    eventSink,
    canaryCoordinator,
    logger: deps.logger,
    metrics: deps.metrics,
    // JOB-015 slice (f) — `drain` becomes a DELIVERED command here, and this is the
    // line that makes it one. Being in the renew payload is not delivery; a worker-side
    // handler applying it is.
    //
    // ★ A THUNK, and it has to be. `pollLoop` is composed BELOW this call (the driver IS
    // its supervisor seam), so `stopLeasing` does not exist yet. Passing a value would
    // capture `undefined` and every delivered drain would be a silent no-op — a
    // composition-root port that is a NO-OP for everything built earlier. The thunk is
    // only ever invoked while a lease is being renewed, which is necessarily after
    // `pollLoop` is assigned.
    //
    // ★★ `stopLeasing()` is the EXISTING drain semantic, not a second copy of it: the
    // poll loop stops taking offers and `drainInFlight()` at exit finishes the attempt
    // already running. A `drain` command therefore does exactly what an operator drain
    // and a rolling shutdown do, through the same code.
    //
    // `result` is deliberately ABSENT. Nothing in the daemon applies a
    // `product_approval_result` / `runtime_decision_result` yet — E8/BRW-004 owns the
    // browser-side applier — so those kinds are counted `control_command{outcome=
    // "unhandled"}` and stay pending for redelivery. That is the honest state; a stub
    // that ACKed them would clear the queue and hide the gap.
    controlHandlers: () => ({
      drain: () => {
        deps.logger?.info({ reason: "control_command" }, "worker: drain requested by the control plane");
        pollLoop.stopLeasing();
      },
    }),
  });

  const limiter = new ConcurrencyLimiter({
    batch: deps.concurrency.batch,
    // config uses `browser`; the limiter's workload class is `browser_session`.
    browser_session: deps.concurrency.browser,
    service: deps.concurrency.service,
  });
  const probes = deps.probes ?? createHostCapacityProbes(defaultHostProbeReaders(deps.workDir));
  const rc = deps.self.verifiedProviderConstraints.resourceCeiling;
  // Clamp to the SERVER-owned provider ceiling: a worker advertising above it is rejected by the
  // frozen matcher, so composing without the clamp produces a worker that polls forever unmatched.
  const measure = (): ReturnType<typeof measureCapacity> =>
    measureCapacity({
      probes,
      reserved: NO_RESERVATION,
      slots: limiter.snapshot(), // LIVE per call — the limiter's slot counts are the backpressure
      ceiling: { cpuMillis: rc.cpuMillis, memoryMiB: rc.memoryMiB, diskMiB: rc.diskMiB },
    });

  // (2) The poll loop leases through the DRIVER, not the raw supervisor.
  const pollLoop = makePollLoop({
    client: deps.client,
    self: deps.self,
    key: deps.key,
    session,
    limiter,
    measure,
    supervisor: driver,
    backoff: deps.backoff,
    metrics: deps.metrics,
    logger: deps.logger,
  });

  return {
    leasing: { stopLeasing: () => pollLoop.stopLeasing(), drain: () => pollLoop.drain() },
    renewal: { stop: () => driver.stop() },
    eventOutbox: {
      stopDrain: () => drain.stop(),
      flush: () => drain.flush(),
      closeStore: () => store.close(),
    },
    self: deps.self,
    measure,
    loopSupervisorSeam: driver,
    limiter,
    start: () => {
      drain.start();
      // Fire-and-forget: a terminal poll-loop stop keeps the daemon UP serving health.
      void pollLoop.run();
    },
    pollLoop,
  };
}
