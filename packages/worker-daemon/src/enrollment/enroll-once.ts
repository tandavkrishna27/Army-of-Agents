// packages/worker-daemon/src/enrollment/enroll-once.ts
//
// DSK-001 — the enrolment coordinator (I3, I6, I7, I13).
//
// This is the piece whose failure mode is PERMANENT. If a device ever enrols
// under a second identity the server denies it at BOTH of its denial sites
// (`worker-enrollment.ts:418-423` for a bound worker, `:453-458` for a globally
// known workerId), and `findWorkerForBinding` filters on
// scope / target / organization / owner with NO status predicate — so even the
// revoked row keeps matching forever and there is no reset route.
//
// FIVE ORDERINGS ARE LOAD-BEARING, and four are inversions of the obvious:
//
//  1. The store verdict precedes any read of the ticket. A fault-store boot must
//     never materialize a live single-use credential in memory — and, with the
//     reader's non-local-path rejection, must perform no file or network I/O for
//     it either.
//  2. A device already holding BOTH an identity and a receipt short-circuits
//     before reading the ticket. After one successful enrolment the device never
//     reads the code and never contacts the control plane again, which makes the
//     ten-minute code TTL, the rebind rule and the retry traps all unreachable on
//     the ordinary boot path.
//  3. PERSIST STRICTLY BEFORE THE NETWORK CALL. The mint-then-enrol-then-persist
//     shape is the lockout generator: crash after the server commits but before
//     the persist, and the next boot mints a second workerId that is denied
//     forever.
//  4. A lost compare-and-set DISCARDS what this process minted and adopts the
//     winner's COMPLETE record — workerId and key together — so two processes
//     never present two identities.
//  5. The key is re-derived from the PERSISTED bytes even on the freshly-minted
//     path, so both paths run identical code and an envelope round-trip bug
//     surfaces on the first run, before the server has committed anything.
//
// AND IT CALLS `renew()`, NOT `enroll()`. `enroll()` mints a fresh idempotency
// key per call (`enroll.ts:230`) and only RETURNS it — nothing persists it — so a
// lost response across a restart hits
// `stored.semanticIdempotencyKey !== request.idempotencyKey`
// (`worker-enrollment.ts:325-327`) and becomes a terminal 400 on a code that can
// never be re-consumed. `renew()` accepts a caller-supplied key and `submit`
// builds a byte-identical body either way; the server decides fresh-vs-replay
// from `consumedAt`.

import { createEnroller, type Enroller, type WorkerSession } from "./enroll.js";
import type { ControlPlaneClient } from "../transport/client.js";
import { buildDesktopHello } from "./desktop-hello.js";
import { deriveEnrollmentIdempotencyKey } from "./idempotency.js";
import type { EnrollmentInput } from "./enrollment-input.js";
import {
  deviceKeyFromPkcs8Der,
  exportDevicePrivateKeyPkcs8Der,
  generateDeviceKey,
  type DeviceKey,
} from "../identity/device-key.js";
import {
  frozenDeviceKeyView,
  type DeviceEnrollmentReceipt,
  type DeviceIdentityRecord,
  type DeviceRecordStore,
} from "../identity/device-identity-store.js";

export class EnrollOnceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrollOnceError";
  }
}

/**
 * A failure of the NETWORK call specifically, carrying whether this boot minted.
 *
 * Amendment A1. Everything else here throws a plain `EnrollOnceError` and is
 * unconditionally fatal — a store that cannot open must never look survivable
 * (I3), and a ticket we cannot parse is not something to run past.
 *
 * An authority failure is different, and the difference is `minted`:
 *
 *   minted === true   a fresh device that could not enrol is useless. The caller
 *                     should exit non-zero. The loop is bounded because the next
 *                     boot LOADS the persisted record rather than minting again.
 *
 *   minted === false  the identity is intact and already on disk. Exiting would
 *                     turn a survivable state into a restart loop — and a restart
 *                     loop is exactly what pressures an operator toward
 *                     `--reset-identity`, which on the same target IS the
 *                     permanent lockout. The caller should log and run idle.
 *
 * The underlying error travels as `cause` rather than being flattened into the
 * message, so the daemon's `err` serializer and its redactor still see a real
 * Error. A pre-stringified transport message would bypass both.
 *
 * The enrollment code is never an input to this type. `workerId` and `targetId`
 * are opaque ids the logger deliberately leaves visible.
 */
export class EnrollmentAuthorityError extends EnrollOnceError {
  readonly minted: boolean;
  readonly workerId: string;
  readonly targetId: string;
  override readonly cause: unknown;

  constructor(input: {
    minted: boolean;
    workerId: string;
    targetId: string;
    cause: unknown;
  }) {
    super(
      input.minted
        ? "device enrollment could not reach authority after minting a new identity"
        : "device enrollment could not reach authority; the existing identity is intact",
    );
    this.name = "EnrollmentAuthorityError";
    this.minted = input.minted;
    this.workerId = input.workerId;
    this.targetId = input.targetId;
    this.cause = input.cause;
  }
}

export interface EnrollOnceDeps {
  readonly identityStore: DeviceRecordStore<DeviceIdentityRecord>;
  readonly receiptStore: DeviceRecordStore<DeviceEnrollmentReceipt>;
  readonly client: ControlPlaneClient;
  /** Already-resolved ticket, or a reader invoked only when one is needed. */
  readonly input?: EnrollmentInput;
  readonly readInput?: () => EnrollmentInput;
  readonly platform: string;
  readonly arch: string;
  /** Injected SPECIFICALLY so mint-once is proven by counting calls (I7). */
  readonly randomWorkerId?: () => string;
  readonly generateKey?: () => DeviceKey;
  /**
   * Injected so the coordinator's ordering can be tested without standing up a
   * fake HTTP control plane. The no-mint property it relies on is proven
   * separately and directly against `frozenDeviceKeyView`, which is pure — so
   * injecting here does not weaken I3.
   */
  readonly createEnrollerFn?: (deps: { keyStore: ReturnType<typeof frozenDeviceKeyView>; client: ControlPlaneClient }) => Enroller;
  /**
   * WRK-010 slice 2 (`E4-F012`) — a SINK for the freshly-minted enrolment session, invoked at
   * the point `result.session` is otherwise dropped (below). OPTIONAL by design: a composition
   * root that omits it still compiles (so the omission is a killable test, not a type error),
   * and every non-composing boot — the shipped default — passes nothing and behaves exactly as
   * before. This is NOT a re-opening of I13: `EnrollmentOutcome` is UNCHANGED (still frozen,
   * still the same key allowlist, still no session/token key), and the invariant I13 protects is
   * the RETURNED AGGREGATE — a store is not a value anyone logs. See WRK-010 §9.1.1.
   */
  readonly onSessionMinted?: (session: WorkerSession) => void;
}

/**
 * The outcome. A frozen object with a fixed key allowlist and NO session or token
 * key — I13. `EnrollResult` is a plain object literal containing `session.token`,
 * so a single `logger.info({ result })` would put a live bearer token in the
 * logs. Nothing downstream can log what it never receives.
 */
export interface EnrollmentOutcome {
  readonly enrolled: boolean;
  readonly minted: boolean;
  readonly skipped: boolean;
  readonly workerId: string;
  readonly targetId: string;
  readonly deviceGeneration: number;
  readonly deviceThumbprint?: string;
}

const FIRST_GENERATION = 1;

export async function enrollOnce(deps: EnrollOnceDeps): Promise<EnrollmentOutcome> {
  const randomWorkerId = deps.randomWorkerId ?? (() => crypto.randomUUID());
  const generateKey = deps.generateKey ?? generateDeviceKey;

  // (1) THE STORE VERDICT FIRST. A throw here is fatal and deliberate: zero
  // mints, and the ticket is still unread.
  let identity = deps.identityStore.load();
  const receipt = deps.receiptStore.load();

  // (2a) THE RECEIPT AND THE IDENTITY MUST AGREE.
  //
  // Four quadrants are possible on disk, and only three were handled. A receipt
  // WITHOUT an identity is a device claiming an enrolment whose private key is
  // gone — AV quarantine, a selective restore, an operator deleting "the key
  // file". Falling through to the mint gate (which tests `identity === null`
  // alone) minted a SECOND identity that the server denies permanently.
  //
  // Refusing does not recover the device: the precondition already destroyed the
  // key. It converts a silent, durable false success into a diagnosable failure.
  // Without it the worst case is not the failed mint but what follows — once a
  // receipt exists, every later boot short-circuits below and reports the device
  // enrolled as the receipt's worker while it holds a different worker's key,
  // forever, without ever retrying or erroring.
  if (receipt && !identity) {
    throw new EnrollOnceError(
      "an enrollment receipt exists but the device identity is missing; " +
        "refusing to mint a second identity (reset the device deliberately to re-enrol)",
    );
  }
  if (identity && receipt && identity.workerId !== receipt.workerId) {
    throw new EnrollOnceError(
      "the stored identity and enrollment receipt disagree about the worker; refusing to proceed",
    );
  }

  // (2b) Steady state. No ticket read, no network — ever again.
  if (identity && receipt) {
    return Object.freeze({
      enrolled: true,
      minted: false,
      skipped: true,
      workerId: receipt.workerId,
      targetId: receipt.targetId,
      deviceGeneration: receipt.deviceGeneration,
      deviceThumbprint: receipt.deviceThumbprint,
    });
  }

  // (3) Only now does a live credential enter memory.
  const input = deps.input ?? deps.readInput?.();
  if (!input) throw new EnrollOnceError("no enrollment input available");

  // (4) A persisted identity for a DIFFERENT target is a refusal, never a
  // re-enrolment: re-minting here would be the lockout, and silently enrolling
  // the old identity against a new target would misattribute the device.
  if (identity && identity.targetId !== input.targetId) {
    throw new EnrollOnceError(
      "persisted identity belongs to a different target; refusing to re-enrol",
    );
  }

  let minted = false;
  if (identity === null) {
    const workerId = randomWorkerId();
    const key = generateKey();
    const candidate: DeviceIdentityRecord = {
      v: 1,
      workerId,
      targetId: input.targetId,
      deviceGeneration: FIRST_GENERATION,
      privateKeyPkcs8Der: exportDevicePrivateKeyPkcs8Der(key),
    };

    // THE DURABILITY POINT — strictly before the network call.
    if (deps.identityStore.saveIfAbsent(candidate) === "stored") {
      identity = candidate;
      minted = true;
    } else {
      // Lost the race. DISCARD what we minted and adopt the winner's complete
      // record. Never reuse the local candidate: that is how two identities
      // reach the server.
      identity = deps.identityStore.load();
      if (identity === null) {
        // The store said "already present" and then produced nothing. Minting
        // again here is the permanent lockout; refusing is recoverable.
        throw new EnrollOnceError(
          "identity store reported an existing record but returned none; refusing to mint again",
        );
      }
      minted = false;
    }
  }

  // (5) Re-derive from the PERSISTED bytes on both paths, so a round-trip bug
  // surfaces on the first run rather than after the server has committed.
  const key = deviceKeyFromPkcs8Der(identity.privateKeyPkcs8Der);

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

  // THE NETWORK POINT. `renew`, not `enroll` — see the header note.
  const makeEnroller = deps.createEnrollerFn ?? createEnroller;
  const enroller = makeEnroller({ keyStore: frozenDeviceKeyView(key), client: deps.client });
  let result;
  try {
    result = await enroller.renew({
      hello,
      code: input.enrollmentCode,
      idempotencyKey,
    });
  } catch (err) {
    // A1. Typed HERE and nowhere else: this is the only point at which the
    // failure is known to be the network rather than our own custody, and the
    // only point at which `minted` is still in scope. Everything above stays a
    // plain throw and stays unconditionally fatal.
    throw new EnrollmentAuthorityError({
      minted,
      workerId: identity.workerId,
      targetId: identity.targetId,
      cause: err,
    });
  }

  // The receipt write's verdict is LOAD-BEARING, not fire-and-forget. An
  // `already_present` here means a receipt existed that `load()` did not return
  // at the top of this function — so it disagrees with what we just enrolled.
  // Discarding that let the stale receipt survive and be reported by every later
  // boot. Refusing surfaces it while an operator can still act.
  const receiptWrite = deps.receiptStore.saveIfAbsent({
    v: 1,
    workerId: identity.workerId,
    targetId: identity.targetId,
    deviceGeneration: identity.deviceGeneration,
    deviceThumbprint: result.deviceThumbprint,
  });
  if (receiptWrite === "already_present") {
    throw new EnrollOnceError(
      "an enrollment receipt already existed for this device after enrolling; " +
        "refusing to leave a receipt that disagrees with the stored identity",
    );
  }

  // `result.session` is dropped from the RETURNED OUTCOME here and never returned (I13). WRK-010
  // slice 2 (`E4-F012`) hands it to the store via the sink FIRST — a store, not a loggable value,
  // so the outcome below is byte-for-byte what it always was (frozen, no session/token key).
  deps.onSessionMinted?.(result.session);

  return Object.freeze({
    enrolled: true,
    minted,
    skipped: false,
    workerId: identity.workerId,
    targetId: identity.targetId,
    deviceGeneration: identity.deviceGeneration,
    deviceThumbprint: result.deviceThumbprint,
  });
}
