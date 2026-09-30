/**
 * The production worker session lifecycle (WRK-010 slice 2 / go-book Sprint 2.5).
 *
 * This is the construction the go-book moved OUT of WRK-008 slice 2b: *"the production identity
 * + SessionStore construction moves here, and Sprint 3 composes the poll loop … on top of a
 * session lifecycle that already works."* It wires the two acquisition paths `SessionStore`
 * needs and returns the `store` (Sprint 3 threads it into `createSessionProvider` → the poll
 * loop) plus the `onSessionMinted` sink (the boot root hands it to `enrollOnce`):
 *
 *   - `renew(current)`  → the WRK-010 device-proof renewal client (`createSessionRenewer`).
 *   - `bootstrap()`     → the enrollment code REPLAY (`Enroller.renew`), which recovers a first
 *                         session on a steady-state boot while the code route is still live.
 *   - `onSessionMinted` → `store.set`, so the ENROLLING boot's session (dropped from the
 *                         `EnrollmentOutcome` by I13) reaches the store without ever being logged.
 *
 * The device key is derived LAZILY from the persisted identity, because on the enrolling boot no
 * identity is on disk when this factory runs (enrolment persists it first, at
 * `enroll-once.ts:232`, before the network call) — and neither `renew` nor `bootstrap` is called
 * until after enrolment. Construction itself performs NO acquisition and NO key read.
 */

import { deviceKeyFromPkcs8Der, type DeviceKey } from "./device-key.js";
import { SessionStore } from "./session.js";
import { createSessionRenewer } from "./session-renewal.js";
import {
  frozenDeviceKeyView,
  type DeviceIdentityRecord,
  type DeviceRecordStore,
} from "./device-identity-store.js";
import { buildDesktopHello } from "../enrollment/desktop-hello.js";
import { deriveEnrollmentIdempotencyKey } from "../enrollment/idempotency.js";
import { createEnroller, type Enroller, type WorkerSession } from "../enrollment/enroll.js";
import type { EnrollmentInput } from "../enrollment/enrollment-input.js";
import type { ControlPlaneClient } from "../transport/client.js";
import type { Logger } from "../logging/logger.js";
import type { Metrics } from "../metrics/metrics.js";

export interface WorkerSessionLifecycleDeps {
  /** The OS-custody identity store — the device key source (os_keychain; §3.2). */
  readonly identityStore: DeviceRecordStore<DeviceIdentityRecord>;
  /** Control-plane client for both the renewal route and the bootstrap enroll route. */
  readonly client: ControlPlaneClient;
  readonly now: () => number;
  /** Lazy enrollment-code reader for `bootstrap` — the SAME thunk the boot root gives `enrollOnce`. */
  readonly readInput: () => EnrollmentInput;
  readonly platform: string;
  readonly arch: string;
  readonly metrics?: Metrics;
  readonly logger?: Logger;
  /** Test seams (not wired in production). */
  readonly createRenewer?: typeof createSessionRenewer;
  readonly createEnrollerFn?: (deps: { keyStore: ReturnType<typeof frozenDeviceKeyView>; client: ControlPlaneClient }) => Enroller;
}

export interface WorkerSessionLifecycle {
  /** Sprint 3 threads this into `createSessionProvider(store)` → `createPollLoop`. */
  readonly store: SessionStore;
  /** The boot root passes this to `enrollOnce` — fires only on the enrolling boot. */
  readonly onSessionMinted: (session: WorkerSession) => void;
}

export function createWorkerSessionLifecycle(deps: WorkerSessionLifecycleDeps): WorkerSessionLifecycle {
  const makeRenewer = deps.createRenewer ?? createSessionRenewer;
  const makeEnroller = deps.createEnrollerFn ?? createEnroller;

  let cachedKey: DeviceKey | undefined;
  const loadIdentity = (): DeviceIdentityRecord => {
    const identity = deps.identityStore.load();
    if (!identity) {
      throw new Error("worker session lifecycle: no device identity on disk (cannot acquire a session)");
    }
    return identity;
  };
  const deviceKey = (): DeviceKey => {
    // The persisted key is stable after enrolment; deriving once is enough. Never called at
    // construction — only when renew/bootstrap actually fire, post-enrolment.
    return (cachedKey ??= deviceKeyFromPkcs8Der(loadIdentity().privateKeyPkcs8Der));
  };

  const renew = (current: WorkerSession): Promise<WorkerSession> =>
    makeRenewer({ client: deps.client, key: deviceKey(), now: deps.now })(current);

  const bootstrap = async (): Promise<WorkerSession> => {
    const identity = loadIdentity();
    const key = deviceKey();
    const hello = buildDesktopHello({
      workerId: identity.workerId,
      targetId: identity.targetId,
      deviceGeneration: identity.deviceGeneration,
      platform: deps.platform,
      arch: deps.arch,
    });
    const idempotencyKey = deriveEnrollmentIdempotencyKey(
      identity.workerId,
      identity.targetId,
      identity.deviceGeneration,
    );
    // Lazy code read — the value hops straight into the `renew({...})` argument and is never
    // bound to a local, logged, or aggregated (the I13 discipline enroll-once.ts:274-278 uses).
    const enroller = makeEnroller({ keyStore: frozenDeviceKeyView(key), client: deps.client });
    const result = await enroller.renew({ hello, code: deps.readInput().enrollmentCode, idempotencyKey });
    return result.session;
  };

  const store = new SessionStore(
    { now: deps.now, renew, bootstrap, metrics: deps.metrics, logger: deps.logger },
    null,
  );

  return { store, onSessionMinted: (session) => store.set(session) };
}
