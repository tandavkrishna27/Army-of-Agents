// DEP-010 (Sprint 2) — the dispatch-composition decision is a PUBLIC export.
//
// The composition root that supplies the `provider` input lives OUTSIDE this package
// (`packages/worker-keystore/src/bin/desktop-host.ts`, by E4-D01 — the daemon defines the
// `SandboxProvider` port and cannot import an implementation of it). For that root to prove
// "the shipped default refuses with no_provider" it must import the decision and its
// refusal-message map from the package barrel, rather than reaching into a private lifecycle
// module. This test PINS that surface. DEP-010 Steps 3+ assert against it; WRK-008 slice 2b
// (Sprint 3) then narrows it — retiring `no_self_model_reader`, swapping `hasSelfModelReader`
// for `hasWorkerIdentity`, etc. — and this file is one of the two artifacts that moves there
// (DEP-010 design §10.3). It is listed there in advance so that narrowing is read, not
// discovered as a red test.

import { describe, expect, it } from "vitest";

import {
  decideDispatchComposition,
  DISPATCH_REFUSAL_MESSAGES,
  type DispatchRefusalReason,
  type SelfModelReadResult,
} from "../index.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import type { WorkerSelfModel } from "../poll/capacity.js";

const OK: SelfModelReadResult = { kind: "ok", selfModel: {} as WorkerSelfModel };

describe("decideDispatchComposition on the package barrel (DEP-010 surface, narrowed by 2b)", () => {
  it("the shipped-shape input (no provider) refuses with no_provider", () => {
    // Exactly the input `bin/worker-daemon.ts` builds on the shipped default: no provider.
    // The deepest fact wins, so the reason is no_provider even with every later gate on.
    expect(
      decideDispatchComposition({
        provider: undefined,
        dispatchEnabled: true,
        hasWorkerIdentity: true,
        hasEventOutboxPath: true,
        selfModelRead: OK,
      }),
    ).toEqual({ compose: false, reason: "no_provider" });
  });

  it("with a provider present, the flag ALONE toggles compose vs dispatch_disabled", () => {
    // The non-vacuous row: absence of a provider already forces no_provider, so the flag
    // is only observable once a provider is injected — which is what a composition root does.
    const provider = createFakeSandboxProvider({});
    expect(
      decideDispatchComposition({
        provider,
        dispatchEnabled: true,
        hasWorkerIdentity: true,
        hasEventOutboxPath: true,
        selfModelRead: OK,
      }),
    ).toEqual({ compose: true, selfModel: OK.kind === "ok" ? OK.selfModel : undefined });
    expect(
      decideDispatchComposition({
        provider,
        dispatchEnabled: false,
        hasWorkerIdentity: true,
        hasEventOutboxPath: true,
        selfModelRead: OK,
      }),
    ).toEqual({ compose: false, reason: "dispatch_disabled" });
  });

  it("the frozen refusal-message map is exported and has a message for every reason", () => {
    const reasons: DispatchRefusalReason[] = [
      "no_provider",
      "dispatch_disabled",
      "no_worker_identity",
      "no_event_outbox_path",
      "no_session",
      "no_self_model",
    ];
    for (const reason of reasons) expect(DISPATCH_REFUSAL_MESSAGES[reason]).toBeTruthy();
  });
});
