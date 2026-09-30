// WRK-008 slice 2b — the worker's dispatch identity: the device key + the hello.
//
// ★ RE-SCOPED BY Step 0 / go-book §4 Sprint 3. Sprint 2.5 (WRK-010 slice 2) OWNS the
// SessionStore + session lifecycle construction (`createWorkerSessionLifecycle`), so this
// module does NOT build a store, a renew thunk or a SessionProvider — the composition
// threads Sprint 2.5's `lifecycle.store` in (§0.2A). What survives here is the
// body-independent half: re-derive the device key from the PERSISTED bytes, and build the
// PROVISIONED hello (WRK-011, §0.2B) that makes this worker matchable.
//
// WHY re-derive the key from the persisted DER rather than reuse an in-memory key: it is
// the same rule `enroll-once.ts:263` follows, so an envelope round-trip bug surfaces on
// first boot rather than after the control plane has committed a snapshot the daemon can
// no longer reproduce.
//
// WHY the hello lives here and not in the self-model reader: both the reader
// (`assembleWorkerSelfModel`'s `report`) and the self-hello refresh submit the identical
// value, and two construction sites are two things to keep byte-identical.

import type { DeviceKey } from "./device-key.js";
import { deviceKeyFromPkcs8Der } from "./device-key.js";
import type { DeviceIdentityRecord } from "./device-identity-store.js";
import { buildDesktopHello, type HelloProvisioning } from "../enrollment/desktop-hello.js";
import type { WorkerHelloV1 } from "@armyofagents/worker-protocol";

export interface WorkerIdentity {
  readonly key: DeviceKey;
  readonly workerId: string;
  readonly targetId: string;
  readonly deviceGeneration: number;
  /** The PROVISIONED hello (matchable) when `provisioning` was present; the unprovisioned
   * (unmatchable) DSK-001 hello when it was `null` (fail toward absent). */
  readonly hello: WorkerHelloV1;
}

export function createWorkerIdentity(input: {
  readonly record: DeviceIdentityRecord;
  readonly platform: string;
  readonly arch: string;
  /** WRK-011 provisioning folded from the self-model read; `null` ⇒ unmatchable hello (D4). */
  readonly provisioning: HelloProvisioning | null;
}): WorkerIdentity {
  const key = deviceKeyFromPkcs8Der(input.record.privateKeyPkcs8Der);
  const hello = buildDesktopHello({
    workerId: input.record.workerId,
    targetId: input.record.targetId,
    deviceGeneration: input.record.deviceGeneration,
    platform: input.platform,
    arch: input.arch,
    provisioning: input.provisioning ?? undefined,
  });
  return {
    key,
    workerId: input.record.workerId,
    targetId: input.record.targetId,
    deviceGeneration: input.record.deviceGeneration,
    hello,
  };
}
