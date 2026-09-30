/**
 * Worker-daemon container/desktop entrypoint (WRK-001, `bin` target).
 *
 * Composition root: config → logger → metrics → health server → shutdown, then
 * blocks. It dispatches NO work in CORE (the poll loop lands in WRK-003). On an
 * invalid config it exits non-zero BEFORE opening the health server or any
 * socket. `bootstrapWorkerDaemon` is factored out (injectable `env`, `proc`, and
 * subsystem factories) so the signal-wiring and fail-closed-config behavior are
 * unit-testable without spawning a process.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@armyofagents/worker-protocol";

import { loadWorkerConfig, WORKER_VERSION, type WorkerConfig } from "../config/config.js";
import type { Env } from "../config/env.js";
import { createWorkerLogger, type Logger } from "../logging/logger.js";
import { createMetrics, type Metrics } from "../metrics/metrics.js";
import { startHealthServer, type HealthServerHandle } from "../health/health-server.js";
import type { HostStateRecord } from "../control/host-state.js";
import {
  createEventOutboxShutdownSteps,
  createLeaseLifecycleSteps,
  createShutdownHandler,
  type EventOutboxLifecycle,
  type LeasingLifecycle,
  type RenewalLifecycle,
  type ShutdownSignal,
} from "../lifecycle/shutdown.js";
import { createStartupSteps, runStartupSteps, type StartupReconciler } from "../lifecycle/startup-steps.js";
import {
  resolveCustody,
  type DeviceEnrollmentReceipt,
  type DeviceIdentityRecord,
  type DeviceRecordStore,
} from "../identity/device-identity-store.js";
import { createControlPlaneClient, type ControlPlaneClient } from "../transport/client.js";
import {
  decideDispatchComposition,
  DISPATCH_REFUSAL_MESSAGES,
  shouldComposeSession,
  type MakeRunProvider,
} from "../lifecycle/compose-dispatch.js";
import type { SandboxProvider } from "../supervisor/provider.js";
import { composeDispatchRuntime, type DispatchRuntime } from "../lifecycle/dispatch-runtime.js";
import { readWorkerSelfModel } from "../identity/self-model-read.js";
import { refreshSelfHello } from "../identity/self-hello-refresh.js";
import { createWorkerIdentity } from "../identity/worker-identity.js";
import { deriveHelloProvisioning } from "../enrollment/hello-provisioning.js";
import { buildDesktopHello } from "../enrollment/desktop-hello.js";
import { deviceKeyFromPkcs8Der } from "../identity/device-key.js";
import { createSessionProvider } from "../poll/poll-loop.js";
import { createHeartbeatLoop, type HeartbeatLoop } from "../poll/heartbeat-loop.js";
import { sha256Hex } from "../identity/device-proof.js";
import type { WorkerCapacity } from "@armyofagents/worker-protocol";
import {
  enrollOnce,
  EnrollmentAuthorityError,
  type EnrollmentOutcome,
} from "../enrollment/enroll-once.js";
import { readEnrollmentInput } from "../enrollment/enrollment-input.js";
import {
  createWorkerSessionLifecycle,
  type WorkerSessionLifecycle,
} from "../identity/worker-session-lifecycle.js";

/** The subset of `process` the entrypoint needs; injected for tests. */
export interface ProcessLike {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  exit(code: number): void;
}

export interface BootstrapDeps {
  readonly env: Env;
  readonly proc: ProcessLike;
  readonly createLogger?: typeof createWorkerLogger;
  /**
   * DSK-003 — write the host's log to this file instead of stdout.
   *
   * A desktop background host has nowhere for stdout to go. OPTIONAL and absent by
   * default, so every container keeps logging to stdout exactly as before.
   */
  readonly logFilePath?: string;
  /**
   * DSK-003 — publish the host state record once the health socket is listening.
   *
   * OPTIONAL, and absent by default. Every deployed compose file bootstraps without a
   * desktop host, so requiring this would be a live behaviour change to running
   * containers rather than a new capability. With no writer configured no record is
   * published, no instance nonce reaches the health server, and `/instance` stays 404 —
   * the surface is byte-identical to the pre-DSK-003 container.
   */
  readonly writeHostState?: (record: HostStateRecord) => Promise<void>;
  /** Remove the record on shutdown. Paired with `writeHostState`. */
  readonly removeHostState?: () => Promise<void>;
  readonly createMetricsFn?: typeof createMetrics;
  readonly startHealth?: typeof startHealthServer;
  /**
   * The WRK-003 poll loop as a leasing lifecycle. When present, its
   * lease-stop-before-drain steps are registered AHEAD of the health-server stop
   * so a shutdown signal stops new leasing before draining in-flight work.
   *
   * It is NOT wired at runtime yet: starting a real loop needs the worker's
   * server-assigned self-model (registered target profile + verified provider
   * constraints), which the as-built JOB-002 enroll response does not deliver
   * (only a provider ref). Until that provisioning lands, the daemon composes the
   * loop's shutdown seam but dispatches no work (rollback = omit the loop).
   */
  readonly leasing?: LeasingLifecycle;
  /**
   * The WRK-005 lease-renewal driver as a renewal lifecycle. When present (with a
   * loop), its `renewal-stop` step is registered between `lease-stop` and
   * `lease-drain` so no renew fires during drain. In the wired composition the
   * driver DECORATES the supervisor seam (it is itself a `SupervisorSeam`), so the
   * poll loop hands ACKed leases to the driver, which renews them and — on lease
   * loss — closes the local fence-close proxy before escalating cleanup. Like the
   * loop it is inert until live dispatch is wired (E4-D12; rollback = omit it).
   */
  readonly renewal?: RenewalLifecycle;
  /**
   * The WRK-006 durable event outbox as a shutdown lifecycle. When present, its
   * ordered `event-outbox-stop → event-outbox-flush → event-outbox-close` steps are
   * registered after the lease steps and before the health-server stop, so on a
   * signal the daemon stops the drain, attempts a final flush, then closes the
   * store. Like the loop + renewal driver it is INERT until live dispatch is wired
   * (E4-D12; rollback = omit it) — WRK-006 does not rewire the composition root.
   */
  readonly eventOutbox?: EventOutboxLifecycle;
  /**
   * The WRK-007 startup reconciler as a one-shot boot seam. When present it runs
   * ONCE between the health server opening and signal registration — reconciling
   * locally-known sandboxes + outbox streams against inferred control-plane lease
   * authority (kill stale, abandon dead-lease streams, quarantine unknown output).
   * Like the loop / renewal / outbox seams it is INERT until live dispatch is wired
   * (E4-D12): the current default omits it, so the startup pass runs NOTHING and the
   * daemon still dispatches no work (rollback = omit it). WRK-007 does not rewire the
   * composition root to actually run at boot.
   */
  readonly reconciler?: StartupReconciler;
  /**
   * DSK-001 — OS-custody record stores, injected by the HOST.
   *
   * Typed structurally and never imported from the keystore package:
   * `scripts/check-worker-daemon-boundary.mjs` rejects a bare specifier the
   * moment a file under this `src` names one outside the two-dependency pin, so
   * the daemon declares the shape and the host supplies something satisfying it.
   * Absent in `mounted_secret` mode, required in `os_keychain` (I11).
   */
  readonly identityStore?: DeviceRecordStore<DeviceIdentityRecord>;
  readonly receiptStore?: DeviceRecordStore<DeviceEnrollmentReceipt>;

  /**
   * Seams for the enrolment block (D4, amended by A1).
   *
   * NOTE THE POLARITY BREAK from the seams above: `createLogger`/`startHealth`
   * exist so a test can OBSERVE. These exist so a test can enrol with NO network
   * and NO filesystem. `readFileText` is required because
   * `readEnrollmentInput(source, env, readFileText)` injects its reader — that is
   * what makes the `{kind:"path"}` arm testable — and the daemon must supply one.
   */
  /**
   * WRK-008 slice 2 — the sandbox provider a composition root supplies.
   *
   * ★ ABSENT FOR THE SHIPPED BINARY, and that is a guarantee rather than an oversight.
   * `worker-daemon` DEFINES the `SandboxProvider` port and implements it zero times; the
   * only implementation lives in `@armyofagents/sandbox-e2b-provider`, which DEPENDS ON
   * this package — so importing it here would be both an E4-D01 boundary breach and a
   * dependency cycle. The daemon therefore cannot acquire a provider by itself, and
   * `bootstrapWorkerDaemon({ env, proc })` passes none. Dispatch is off by construction,
   * exactly as `leasing`/`renewal`/`reconciler` already are.
   */
  readonly provider?: SandboxProvider;
  /**
   * DEP-011 Slice 2b — the CONTAINER worker's per-run networked provider factory.
   *
   * The container alternative to `provider`: worker-daemon defines the `SandboxProvider`
   * port and cannot construct any implementation (E4-D01), and the networked driver lives
   * OUTSIDE this package too — so a container composition root
   * (`@armyofagents/worker-networked-host`) injects this factory, which builds a per-run
   * driver over the run's minted owned-labels capability AFTER redemption. ABSENT for the
   * shipped binary exactly like `provider`; the boot's provider gate is satisfied by EITHER
   * `provider` OR `makeRunProvider`, and neither ⇒ inert `no_provider`. Threaded via the
   * `MakeRunProvider` alias (not a re-inlined type) so the four bin sites and the gate
   * functions share ONE shape.
   */
  readonly makeRunProvider?: MakeRunProvider;
  readonly createClient?: typeof createControlPlaneClient;
  readonly readFileText?: (path: string) => string;
  readonly enrollOnceFn?: typeof enrollOnce;
  /**
   * WRK-010 slice 2 — the production session lifecycle factory. Injected only for tests; the
   * default builds the real `SessionStore` + renewal client + bootstrap.
   */
  readonly createLifecycleFn?: typeof createWorkerSessionLifecycle;
  /**
   * ★ WRK-008 slice 2b OBSERVATION seam (not a behaviour seam). Overrides
   * `composeDispatchRuntime` so a test can prove the composition was NOT entered on a refusing
   * boot (spy at 0 calls) — the only way "the shipped binary still refuses" is falsifiable.
   */
  readonly composeDispatch?: typeof composeDispatchRuntime;
}

export interface BootstrapResult {
  readonly ok: boolean;
  readonly config?: WorkerConfig;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  readonly health?: HealthServerHandle;
  readonly shutdown?: (signal: ShutdownSignal) => Promise<void>;
}

export async function bootstrapWorkerDaemon(deps: BootstrapDeps): Promise<BootstrapResult> {
  const makeLogger = deps.createLogger ?? createWorkerLogger;
  const makeMetrics = deps.createMetricsFn ?? createMetrics;
  const startHealth = deps.startHealth ?? startHealthServer;

  const logger = makeLogger({ filePath: deps.logFilePath });

  // Fail-closed on invalid config: exit non-zero BEFORE any socket is opened
  // (no health server, no signal handlers).
  let config: WorkerConfig;
  try {
    config = loadWorkerConfig(deps.env);
  } catch (err) {
    logger.error({ err }, "worker-daemon config invalid; refusing to start");
    deps.proc.exit(1);
    return { ok: false, logger };
  }

  logger.info(
    {
      workerVersion: WORKER_VERSION,
      protocolMin: MIN_PROTOCOL_VERSION,
      protocolMax: PROTOCOL_VERSION,
      keyStoreMode: config.keyStoreMode,
      targetScope: config.targetScope,
    },
    "worker-daemon starting",
  );

  // DSK-001 (I11) — CUSTODY BEFORE THE SOCKET.
  //
  // `keyStoreMode` has been parsed since WRK-002 and read only to be logged just
  // above; nothing constructed a store from it. So a deployment configured for
  // `os_keychain` with no store injected would bind its health listener and
  // report itself UP, discovering it had no custody only when something tried to
  // enrol — by which point an operator has been told the worker is healthy.
  //
  // The decision is a pure function so it is provable without a socket, and an
  // unknown mode fails closed rather than degrading to a weaker custody model.
  const custody = resolveCustody(config.keyStoreMode, deps.identityStore, deps.receiptStore);
  if (custody.kind === "refuse") {
    logger.error({ reason: custody.reason }, "worker-daemon custody unavailable; refusing to start");
    deps.proc.exit(1);
    return { ok: false, config, logger };
  }

  const metrics = makeMetrics();
  // DSK-003 — ONE nonce per boot, shared by the health server and the state record. If
  // the two ever disagreed, the stale-pid defence would reject the very host that wrote
  // the record — so they come from a single value here rather than being generated
  // independently at each site.
  const instanceId = deps.writeHostState ? randomUUID() : undefined;
  const health = await startHealth(
    { host: config.health.host, port: config.health.port, instanceId },
    metrics,
  );
  metrics.setWorkerUp(true);

  // AFTER the socket is listening, deliberately: the record advertises a port the
  // stale-pid defence probes, and publishing it earlier would advertise something that
  // cannot answer. `health.port` is the ACTUALLY bound port — the configured one may be
  // 0, and a record carrying 0 would send every control command nowhere.
  if (deps.writeHostState && instanceId) {
    await deps.writeHostState({
      instanceId,
      pid: process.pid,
      healthPort: health.port,
      startedAt: new Date().toISOString(),
      version: WORKER_VERSION,
    });
  }

  // DSK-001 (D4, amended by A1) — ENROL, once, here.
  //
  // AFTER the health server, deliberately: the compose healthcheck must be able
  // to answer while a device is enrolling (D14). The CONFIGURATION verdict is
  // separate and already happened above, pre-socket (I11) — splitting the two is
  // the only shape that satisfies both.
  //
  // Gated on the MODE rather than on the custody verdict, because the verdict is
  // a pure yes/no and deliberately carries neither a mode nor the stores (A1 §1).
  // `mounted_secret` reaches none of this: every deployed compose file uses that
  // mode with no stores, so the `&& deps.identityStore && deps.receiptStore`
  // conjunct is already false for it, and row 3 of the I11 truth table guarantees
  // zero shipped-container behaviour change. WRK-015 shipped the POSIX enrolment-
  // input fix (a container can now present a `/worker/...` ticket path); WRK-017
  // flips a d1 worker to `file_record` via a compose `command:` override. This
  // ticket lands the arm inert.
  //
  // HONEST NOTE ON THIS CONDITION (rewritten for WRK-014 — §9). The mode arm is
  // now the REAL enrol discriminator: it names EXACTLY the two custody modes that
  // enrol — `os_keychain` (desktop) and `file_record` (container) — and each
  // disjunct is load-bearing. Delete the `os_keychain` arm and the os_keychain
  // enrol test reddens; delete the `file_record` arm and the WRK-014 container
  // enrol test reddens. What still SURVIVES is deleting the WHOLE mode check
  // (leaving only the store conjunct): `resolveCustody` already refuses
  // `mounted_secret` WITH stores pre-socket (exit 1) and passes it only WITHOUT
  // stores, so a store-bearing `mounted_secret` can never reach this line — the
  // mode check is defence-in-depth for that one gate being loosened, not a
  // separately-killable guard. So it is honest to keep, and honest to record that
  // the all-or-nothing mutation survives while each named-mode arm does not.
  // WRK-008 slice 2b (Step 7) — the identity gate takes a BOOLEAN, not the identity, so the
  // record load + key derivation stay INSIDE the compose branch (zero residue on a refusing
  // boot — §10). This is set from the enrolment OUTCOME already in scope, never a second
  // `identityStore.load()`: a container leaves it `false` without touching anything (the block
  // below is never entered), and both exits that imply an identity set it true.
  let workerIdentityPresent = false;
  // ★ WRK-008 slice 2b (Sprint 2.5 GAP-1) — HOISTED so the dispatch branch below can thread
  // `lifecycle.store` into the poll loop and reach the same `client` for the self-model read +
  // self-hello refresh. Both stay `undefined` on a non-composing boot (the shipped default).
  let lifecycle: WorkerSessionLifecycle | undefined;
  let controlPlaneClient: ControlPlaneClient | undefined;
  if (
    (config.keyStoreMode === "os_keychain" || config.keyStoreMode === "file_record") &&
    deps.identityStore &&
    deps.receiptStore
  ) {
    const runEnrollment = deps.enrollOnceFn ?? enrollOnce;
    const makeClient = deps.createClient ?? createControlPlaneClient;
    const readFileText = deps.readFileText ?? ((path: string) => readFileSync(path, "utf8"));
    // One client + one lazy code reader, shared by enrolment and the session lifecycle.
    const client = makeClient({ baseUrl: config.controlPlaneBaseUrl });
    controlPlaneClient = client;
    const readInput = () => readEnrollmentInput(config.enrollmentCodeSource, deps.env, readFileText);

    // WRK-010 slice 2 (go-book Sprint 2.5) — option (c): decide whether this daemon composes its
    // SESSION LIFECYCLE BEFORE enrolment, and construct it here, so the enrolment SINK has a store
    // to write into on the enrolling boot. A NON-composing boot (the shipped default: no provider)
    // constructs no store and passes NO sink, so `result.session` is dropped exactly as before and
    // I13 is byte-identical to the pre-slice-2 tree. The lifecycle's `renew` thunk WIRES the renewal
    // route into production — it is the route's first production caller CODE PATH; construction itself
    // acquires nothing (the eager first read is below, after enrolment). The repeated near-expiry
    // renewal that actually DRIVES `renew` in a running process is Sprint 3's poll loop, which threads
    // `lifecycle.store` in (E4-F007 resolution; WRK-010-slice-2-design.md §3.3/§11 R1).
    const composeSession = shouldComposeSession({
      provider: deps.provider,
      makeRunProvider: deps.makeRunProvider,
      dispatchEnabled: config.dispatchEnabled,
    });
    lifecycle = composeSession
      ? (deps.createLifecycleFn ?? createWorkerSessionLifecycle)({
          identityStore: deps.identityStore,
          client,
          now: () => Date.now(),
          readInput,
          platform: process.platform,
          arch: process.arch,
          metrics,
          logger,
        })
      : undefined;

    let outcome: EnrollmentOutcome;
    try {
      outcome = await runEnrollment({
        identityStore: deps.identityStore,
        receiptStore: deps.receiptStore,
        client,
        // A THUNK, not a resolved value: the credential materializes only when a
        // ticket is actually needed, so an already-enrolled device never brings
        // one into memory.
        readInput,
        platform: process.platform,
        arch: process.arch,
        // WRK-010 slice 2 — fires only on the ENROLLING boot; undefined on a non-composing boot.
        onSessionMinted: lifecycle?.onSessionMinted,
      });
    } catch (err) {
      // The survivable branch is deliberately NARROW: only a network failure on
      // a device whose identity already existed. Widening it to "any enrolment
      // error" would silently regress I3 — a locked store would read as a
      // transient problem and the daemon would carry on without custody.
      //
      // And exiting on the narrow case would be its own bug: a device that is
      // fine would restart-loop, and a restart loop is what walks an operator
      // into `--reset-identity`, which on the same target IS the permanent
      // lockout. See amendment A1.
      if (err instanceof EnrollmentAuthorityError && !err.minted) {
        logger.error(
          { err, workerId: err.workerId, targetId: err.targetId },
          "worker-daemon could not obtain authority; running idle with the existing device identity",
        );
        // The device HAS an identity (that is what makes this branch survivable) — the read
        // just could not be authorized. Gate 3 is satisfied; a later gate decides dispatch.
        workerIdentityPresent = true;
      } else {
        logger.error({ err }, "worker-daemon enrollment failed; refusing to start");
        // `.catch(() => {})` matters: a rejected close would otherwise escape
        // bootstrap into the entry guard's `console.error(err.stack)`, which
        // bypasses the redactor entirely (I13).
        await health.close().catch(() => {});
        deps.proc.exit(1);
        return { ok: false, config, logger, metrics };
      }
    }

    if (outcome!) {
      logger.info(
        {
          workerId: outcome.workerId,
          targetId: outcome.targetId,
          deviceGeneration: outcome.deviceGeneration,
          deviceThumbprint: outcome.deviceThumbprint,
        },
        outcome.skipped
          ? "worker-daemon already enrolled; skipping control-plane enrollment"
          : "worker-daemon enrolled",
      );
      // Enrolled or already-enrolled ⇒ a device identity exists on disk. Gate 3 satisfied.
      workerIdentityPresent = true;
    }

    // WRK-010 slice 2 — eagerly acquire the FIRST session, so first-session acquisition is
    // GENUINELY REACHABLE in production, not merely compile-clean: the sink path on the enrolling
    // boot, the bootstrap code-replay on a steady-state boot within the code window. Fail-soft
    // (§3.4.1): a terminal store runs idle pending re-enrollment (a steady-state boot AFTER the
    // code window — the named §11 R2 gap); a transient failure is retried by Sprint 3's poll loop.
    // Repeated near-expiry renewals (the renewal route in a running process) are Sprint 3's driver.
    if (lifecycle) {
      try {
        const acquired = await lifecycle.store.ensureFresh();
        logger.info(
          { expiresAtMs: acquired.expiresAtMs, deviceGeneration: acquired.deviceGeneration },
          "worker-daemon session acquired",
        );
      } catch (err) {
        if (lifecycle.store.isStopped()) {
          logger.error(
            { err },
            "worker-daemon session terminal at boot; running idle — operator re-enrollment required",
          );
        } else {
          logger.warn({ err }, "worker-daemon first session not acquired yet (transient); will retry");
        }
      }
    }
  }

  // WRK-008 slice 2 — decide whether this daemon dispatches, and SAY WHY NOT.
  //
  // Before this, a worker that took no work was silent: an operator could only conclude
  // "it is running" from the health server and had nothing to act on. The decision is a
  // reason, not a boolean, precisely so the log line names which of three different
  // places the fix lives in (rebuild/repackage, edit env, ask an admin).
  //
  // The `compose: true` branch is slice 2b: building the supervisor and poll loop needs
  // the concurrency limiter, capacity probes and event outbox threaded through, which is
  // its own pass. Until then a provider-bearing host still gets an honest answer, and the
  // one thing that CANNOT happen is silent non-dispatch.
  // ★ Step 7 — the decision function is called TWICE, and that is the design. The self-model
  // read is an authenticated round trip; performing it before the cheap gates would waste it. So
  // the SAME pure function decides first with `selfModelRead: null` ("not attempted"), and because
  // both read-derived reasons are LAST, a first answer of exactly `no_self_model` means every
  // earlier gate passed and only the read remains. `no_session` can NEVER come out of the first
  // call. The bin never re-implements the gate order — two copies would drift.
  const dispatch = decideDispatchComposition({
    provider: deps.provider,
    makeRunProvider: deps.makeRunProvider,
    dispatchEnabled: config.dispatchEnabled,
    hasWorkerIdentity: workerIdentityPresent,
    hasEventOutboxPath: config.eventOutboxPath !== null,
    selfModelRead: null,
  });

  let runtime: DispatchRuntime | undefined;
  let heartbeatLoop: HeartbeatLoop | undefined;
  // Wave-4 — the poll loop is started LAZILY, from the heartbeat driver's first successful beat
  // (see below). `pollLoopStarted` makes that start happen at most once; `shuttingDown` (set by the
  // signal handlers) prevents starting a poll loop the shutdown steps have already torn down.
  let pollLoopStarted = false;
  let shuttingDown = false;
  // ★ The read is the ONLY remaining gate exactly when the first answer is `no_self_model` — that
  // is the whole reason for the two-pass shape. This boolean is the load-bearing guard: deleting
  // the `reason === "no_self_model"` check makes it fire for a cheaper refusal (e.g. `no_provider`),
  // where the invariant below then throws rather than composing on a half-built daemon.
  const readIsTheOnlyRemainingGate = !dispatch.compose && dispatch.reason === "no_self_model";
  if (readIsTheOnlyRemainingGate) {
    // Invariant: `no_self_model` on the FIRST pass ⟺ every cheap gate passed, so a provider + flag
    // (⟹ lifecycle), an outbox path, identity custody and a control-plane client are ALL present.
    // Fail loudly if a future refactor breaks that — never compose on a partial daemon.
    if (lifecycle === undefined || controlPlaneClient === undefined || config.eventOutboxPath === null || deps.identityStore === undefined) {
      throw new Error("worker-daemon: no_self_model reached without every cheap-gate dependency present (invariant broken)");
    }
    // The identity itself (record load + PKCS8 re-derivation) is constructed INSIDE this branch,
    // so a boot that refuses earlier derives no device key — the "zero residue" §10 earns.
    const record = deps.identityStore.load();
    if (record !== null) {
      const key = deviceKeyFromPkcs8Der(record.privateKeyPkcs8Der);
      const sessionProvider = createSessionProvider(lifecycle.store);
      const bareHello = buildDesktopHello({
        workerId: record.workerId,
        targetId: record.targetId,
        deviceGeneration: record.deviceGeneration,
        platform: process.platform,
        arch: process.arch,
      });
      const read = await readWorkerSelfModel({
        client: controlPlaneClient,
        session: sessionProvider,
        key,
        report: bareHello,
        sha256Fn: sha256Hex,
      });
      const dispatch2 = decideDispatchComposition({
        provider: deps.provider,
        makeRunProvider: deps.makeRunProvider,
        dispatchEnabled: config.dispatchEnabled,
        hasWorkerIdentity: true,
        hasEventOutboxPath: true,
        selfModelRead: read,
      });
      if (dispatch2.compose) {
        // ★ Fold WRK-011's provisioning into the assembled model and REFRESH the server snapshot
        // (§0.2B). The nameplate capacity is the server-owned ceiling; the poll re-measures + the
        // server Math.min's it. The refresh is best-effort: a failure leaves the snapshot stale
        // (offered nothing) but the daemon healthy and inert.
        const rc = dispatch2.selfModel.verifiedProviderConstraints.resourceCeiling;
        const nameplate: WorkerCapacity = {
          batchSlots: config.concurrency.batch,
          browserSessionSlots: config.concurrency.browser,
          serviceSlots: config.concurrency.service,
          freeCpuMillis: rc.cpuMillis,
          freeMemoryMiB: rc.memoryMiB,
          freeDiskMiB: rc.diskMiB,
        };
        const provisioning = deriveHelloProvisioning({
          selfModelResponse: { registeredProfile: dispatch2.selfModel.registeredTargetProfile },
          isolation: "none",
          capacity: nameplate,
        });
        const identity = createWorkerIdentity({ record, platform: process.platform, arch: process.arch, provisioning });
        const current = lifecycle.store.current();
        if (current !== null) {
          const refreshed = await refreshSelfHello({ client: controlPlaneClient, current, key, hello: identity.hello });
          if (refreshed !== null) lifecycle.store.set(refreshed);
        }
        const composeRuntime = deps.composeDispatch ?? composeDispatchRuntime;
        const composed = await composeRuntime({
          // DEP-011 Slice 2b — pass EXACTLY the injected provider path: the desktop `provider`
          // OR the container `makeRunProvider` (composeDispatchRuntime forwards both to the
          // supervisor, which fail-fasts if both are set; the boot gate above refused if neither).
          // The `!` is gone — `provider` is now legitimately optional (a makeRunProvider-only boot
          // reaches here with `provider === undefined`), so asserting non-null was a type lie.
          provider: deps.provider,
          makeRunProvider: deps.makeRunProvider,
          self: { ...dispatch2.selfModel, report: identity.hello },
          key,
          store: lifecycle.store,
          client: controlPlaneClient,
          eventOutboxPath: config.eventOutboxPath,
          concurrency: config.concurrency,
          backoff: config.backoff,
          workDir: process.cwd(),
          logger,
          metrics,
        });
        runtime = composed;
        // Wave-4 — seed the heartbeat, and start the poll loop ONLY after the first SUCCESSFUL beat.
        // authorityCurrent requires a fresh worker.lastSeenAt (device-liveness.ts); nothing else
        // advances it, and a poll issued before the first heartbeat is denied `target_revoked`,
        // which the poll loop treats as terminal and never retries. So gate runtime.start() on
        // firstBeat === "ok" — LAZILY, not on a bounded boot race: if the control plane is briefly
        // slow at boot, the poll loop is DELAYED until the first beat eventually lands, instead of an
        // otherwise-healthy, actively-beating worker being stranded inert until a restart. boot does
        // NOT block on the beat, so the health server and shutdown handlers come up immediately.
        // `firstBeat` never rejects (the driver is fail-soft), so this `.then` cannot orphan a
        // rejection; the heartbeat loop keeps beating regardless (poll-loop start is the only gate).
        heartbeatLoop = createHeartbeatLoop({
          session: sessionProvider,
          key,
          client: controlPlaneClient,
          intervalMs: config.heartbeatIntervalMs,
          logger,
          metrics,
        });
        heartbeatLoop.start();
        void heartbeatLoop.firstBeat.then((firstBeat) => {
          if (firstBeat !== "ok") {
            // Terminal session before any beat → re-enrollment required. Stay healthy-and-inert.
            logger.warn(
              { workerId: identity.workerId, targetId: identity.targetId, firstBeat },
              "worker-daemon heartbeat terminal before first beat; NOT starting the poll loop (healthy and inert)",
            );
            return;
          }
          // Start at most once, and never after a shutdown began (which would spin up a poll loop the
          // shutdown steps just tore down). ★ A terminal poll-loop stop does not exit the process;
          // the daemon stays UP serving health, the same "healthy and inert" degradation.
          if (pollLoopStarted || shuttingDown) return;
          pollLoopStarted = true;
          composed.start();
          logger.info(
            { workerId: identity.workerId, targetId: identity.targetId },
            "worker-daemon dispatch COMPOSED; heartbeat seeded; leasing through the poll loop",
          );
        });
      } else {
        logger.info(
          { reason: dispatch2.reason, ...(dispatch2.logPayload ?? {}) },
          DISPATCH_REFUSAL_MESSAGES[dispatch2.reason],
        );
      }
    } else {
      logger.info({ reason: "no_worker_identity" }, DISPATCH_REFUSAL_MESSAGES.no_worker_identity);
    }
  } else if (!dispatch.compose) {
    logger.info(
      { reason: dispatch.reason, ...(dispatch.logPayload ?? {}) },
      DISPATCH_REFUSAL_MESSAGES[dispatch.reason],
    );
  }

  // ★ Two leasing lifecycles is a double-lease hazard. Reachable only by injection.
  if (runtime !== undefined && deps.leasing !== undefined) {
    logger.error(
      {},
      "worker-daemon composed a dispatch runtime AND an external leasing seam was injected; refusing to run two leasing lifecycles",
    );
    await health.close().catch(() => {});
    deps.proc.exit(1);
    return { ok: false, config, logger, metrics };
  }

  // WRK-007: the one-shot startup reconciliation pass runs ONCE here — after the
  // health server is up, BEFORE signal registration. Gated on presence: with no
  // reconciler wired (the current default) the step list is empty and nothing runs
  // (inert; E4-D12), exactly how the lease/renewal/outbox seams degrade to [].
  const startupSteps = deps.reconciler ? createStartupSteps(deps.reconciler) : [];
  await runStartupSteps(startupSteps, logger);

  // WRK-003 registers lease-stop AHEAD of drain, both ahead of the health-server
  // stop; WRK-005 inserts renewal-stop between them when a renewal driver is
  // composed. When no loop is wired (the current default — see `leasing` above),
  // the only stop step is the health server.
  // ★ Step 7 — when a runtime is COMPOSED, its lifecycles drive shutdown (leasing stops before
  // draining, renewal timers stop between them, the outbox flushes then closes). Otherwise the
  // injected seams (tests) or nothing (the shipped default) apply.
  const leasing = runtime?.leasing ?? deps.leasing;
  const renewal = runtime?.renewal ?? deps.renewal;
  const eventOutbox = runtime?.eventOutbox ?? deps.eventOutbox;
  const leaseSteps = leasing ? createLeaseLifecycleSteps(leasing, renewal) : [];
  const outboxSteps = eventOutbox ? createEventOutboxShutdownSteps(eventOutbox) : [];
  // Wave-4 — stop the heartbeat driver ahead of the health-server stop (mirrors lease-stop
  // ordering). Synchronous flag flip; wrapped async to match the step signature.
  const heartbeatStopSteps = heartbeatLoop
    ? [{ name: "heartbeat", stop: async () => { heartbeatLoop!.stop(); } }]
    : [];
  const runShutdown = createShutdownHandler({
    steps: [
      ...leaseSteps,
      ...outboxSteps,
      ...heartbeatStopSteps,
      { name: "health-server", stop: () => health.close() },
      // LAST, after health closes. While the host drains, `status` should still find the
      // record — the same reason `stop-host` is last in the uninstall plan. Once health is
      // closed a probe fails and `drain` refuses, which is the right answer for a host
      // already shutting down.
      ...(deps.removeHostState
        ? [{ name: "host-state", stop: () => deps.removeHostState!() }]
        : []),
    ],
    logger,
    exit: (code) => deps.proc.exit(code),
    flush: () => logger.flush(),
  });
  // Wave-4 — flip `shuttingDown` at the very START of any shutdown (signal OR programmatic), BEFORE
  // the steps run, so a heartbeat first-beat that resolves mid-shutdown cannot start a poll loop the
  // lease-stop step just drained. The heartbeatStopSteps above also stop the driver; this closes the
  // narrow window between lease-stop and heartbeat-stop.
  const shutdown = (signal: ShutdownSignal): Promise<void> => {
    shuttingDown = true;
    return runShutdown(signal);
  };

  deps.proc.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  deps.proc.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  return { ok: true, config, logger, metrics, health, shutdown };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // The daemon blocks on the health server + signal handlers; it dispatches no
  // work in CORE. A rejected bootstrap (e.g. the health port is taken) exits
  // non-zero.
  bootstrapWorkerDaemon({ env: process.env, proc: process }).catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
