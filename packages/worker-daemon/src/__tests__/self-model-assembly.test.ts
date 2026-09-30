// WRK-008 slice 2 — turning the control plane's response into a `WorkerSelfModel`.
//
// ★ THE WHOLE POINT IS THAT THIS CAN RETURN null. The self-model is what the worker
// advertises capacity against, so accepting a profile whose digest does not recompute
// would let a worker advertise ceilings no authority granted — the exact condition slice
// 1's route refuses to serve. Every failure here is a REFUSAL, never a partial model:
// there is no "mostly branded" state to fall back to.
//
// ★ THE FIRST TEST IS A POSITIVE CONTROL, and it is not decoration. My first draft of
// this suite passed `registeredProfile: {}` to every refusal case — which fails the
// registered-profile parse — so the "refuses a tampered digest" test was green because of
// the WRONG field, and would have stayed green with the digest check deleted. A refusal
// suite with no positive control cannot tell "correctly refused" from "never got there".

import { describe, expect, it } from "vitest";

import { assembleWorkerSelfModel } from "../identity/self-model.js";
import {
  buildWorkerHello,
  registeredTargetProfile,
  sealedProviderProfile,
  sha256hex,
} from "./support/poll-fixtures.js";

const HELLO = buildWorkerHello();
const REGISTERED = registeredTargetProfile();
const ok = () => ({ registeredProfile: REGISTERED, providerConstraintProfile: sealedProviderProfile() });

describe("WRK-008 slice 2 — assembleWorkerSelfModel", () => {
  it("★ POSITIVE CONTROL — a correctly sealed profile assembles", async () => {
    const model = await assembleWorkerSelfModel({
      response: ok(),
      report: HELLO,
      sha256Fn: sha256hex,
    });
    expect(model).not.toBeNull();
    expect(model?.report).toBe(HELLO);
    expect(model?.registeredTargetProfile).toEqual(REGISTERED);
  });

  it("★ refuses a profile whose digest does not recompute", async () => {
    // Mutate a field the digest covers. The seal is the ONE authority on whether these
    // bytes are the bytes an operator signed.
    const tampered = { ...sealedProviderProfile(), maxConcurrentSandboxes: 999 };
    expect(
      await assembleWorkerSelfModel({
        response: { registeredProfile: REGISTERED, providerConstraintProfile: tampered },
        report: HELLO,
        sha256Fn: sha256hex,
      }),
    ).toBeNull();
  });

  it("★ refuses when the provider-constraint profile is absent", async () => {
    expect(
      await assembleWorkerSelfModel({
        response: { registeredProfile: REGISTERED, providerConstraintProfile: null },
        report: HELLO,
        sha256Fn: sha256hex,
      }),
    ).toBeNull();
  });

  it("★ refuses when the registered profile is absent or malformed", async () => {
    for (const registeredProfile of [null, {}, "nope"]) {
      expect(
        await assembleWorkerSelfModel({
          response: { registeredProfile, providerConstraintProfile: sealedProviderProfile() },
          report: HELLO,
          sha256Fn: sha256hex,
        }),
      ).toBeNull();
    }
  });

  it("refuses a malformed response rather than throwing", async () => {
    // A daemon that throws here dies on a bad server response instead of staying up
    // inert, which is the Q3 half-started state the design refuses.
    for (const response of [null, undefined, "nope", 42, []]) {
      await expect(
        assembleWorkerSelfModel({ response: response as never, report: HELLO, sha256Fn: sha256hex }),
      ).resolves.toBeNull();
    }
  });

  it("refuses when the digest function throws rather than propagating", async () => {
    await expect(
      assembleWorkerSelfModel({
        response: ok(),
        report: HELLO,
        sha256Fn: () => {
          throw new Error("hash unavailable");
        },
      }),
    ).resolves.toBeNull();
  });
});
