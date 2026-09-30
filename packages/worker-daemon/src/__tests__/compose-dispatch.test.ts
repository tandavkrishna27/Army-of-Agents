// WRK-008 slice 2b — the dispatch-composition decision, now over SIX gates.
//
// This is the function that answers "is this daemon going to take work, and if not, why
// not". It is a DECISION WITH A REASON (and a structured log payload) rather than a
// boolean, because the reason is the operator-facing answer to "why is my worker idle" and
// each of the six gates has a DIFFERENT fix in a different place.
//
// ★ slice 2b retires `no_self_model_reader` (2a's placeholder — the build now HAS a reader)
// and splits the read-derived answers into `no_session` (re-enrol THIS device) and
// `no_self_model` (an admin sets a placement profile). Reporting a dead session as "ask an
// admin" is the single most misleading message available, and §3.2 makes a dead session the
// MOST likely refusal on any worker older than its ten-minute code route.

import { describe, expect, it } from "vitest";

import {
  decideDispatchComposition,
  shouldComposeSession,
  DISPATCH_REFUSAL_MESSAGES,
  type DispatchRefusalReason,
  type SelfModelReadResult,
  type SelfModelReadRefusal,
} from "../lifecycle/compose-dispatch.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import type { WorkerSelfModel } from "../poll/capacity.js";

const PROVIDER = createFakeSandboxProvider({});
const SELF = {} as WorkerSelfModel; // the decision never reads its contents, only ok vs refused
const OK: SelfModelReadResult = { kind: "ok", selfModel: SELF };
const refused = (reason: SelfModelReadRefusal): SelfModelReadResult => ({ kind: "refused", reason });

// Every earlier gate satisfied, so the gate under test is the one that decides.
const ALL_ON = {
  provider: PROVIDER,
  dispatchEnabled: true,
  hasWorkerIdentity: true,
  hasEventOutboxPath: true,
  selfModelRead: OK,
} as const;

describe("decideDispatchComposition — six gates, deepest fact first", () => {
  it("POSITIVE CONTROL: all six satisfied ⇒ composes, carrying the self-model", () => {
    expect(decideDispatchComposition(ALL_ON)).toEqual({ compose: true, selfModel: SELF });
  });

  it("gate 1 — no provider (a BUILD fact) wins over every later gate", () => {
    expect(
      decideDispatchComposition({
        ...ALL_ON,
        provider: undefined,
        dispatchEnabled: false,
        hasWorkerIdentity: false,
        hasEventOutboxPath: false,
        selfModelRead: null,
      }),
    ).toEqual({ compose: false, reason: "no_provider" });
  });

  it("gate 2 — dispatch_disabled wins over identity/outbox/read", () => {
    expect(
      decideDispatchComposition({
        ...ALL_ON,
        dispatchEnabled: false,
        hasWorkerIdentity: false,
        hasEventOutboxPath: false,
        selfModelRead: null,
      }),
    ).toEqual({ compose: false, reason: "dispatch_disabled" });
  });

  it("gate 3 — no_worker_identity is DISTINCT from no_self_model (different owners)", () => {
    expect(
      decideDispatchComposition({
        ...ALL_ON,
        hasWorkerIdentity: false,
        hasEventOutboxPath: false,
        selfModelRead: null,
      }),
    ).toEqual({ compose: false, reason: "no_worker_identity" });
  });

  it("gate 4 — no_event_outbox_path (an env edit on THIS host)", () => {
    expect(
      decideDispatchComposition({ ...ALL_ON, hasEventOutboxPath: false, selfModelRead: null }),
    ).toEqual({ compose: false, reason: "no_event_outbox_path" });
  });

  it("gate 5 — a dead session maps to no_session, NOT no_self_model", () => {
    expect(
      decideDispatchComposition({ ...ALL_ON, selfModelRead: refused("session_terminal") }),
    ).toEqual({
      compose: false,
      reason: "no_session",
      logPayload: { readRefusal: "session_terminal" },
    });
  });

  it("gate 6 — a genuinely missing profile maps to no_self_model; the read was attempted", () => {
    expect(
      decideDispatchComposition({ ...ALL_ON, selfModelRead: refused("no_profile") }),
    ).toEqual({
      compose: false,
      reason: "no_self_model",
      logPayload: { readRefusal: "no_profile" },
    });
    // unassemblable + unavailable also collapse to no_self_model, sub-reason in the payload.
    expect(decideDispatchComposition({ ...ALL_ON, selfModelRead: refused("unassemblable") })).toEqual({
      compose: false,
      reason: "no_self_model",
      logPayload: { readRefusal: "unassemblable" },
    });
    expect(decideDispatchComposition({ ...ALL_ON, selfModelRead: refused("unavailable") })).toEqual({
      compose: false,
      reason: "no_self_model",
      logPayload: { readRefusal: "unavailable" },
    });
  });

  it("null selfModelRead (the read was NOT ATTEMPTED — first pass) ⇒ no_self_model {attempted:false}", () => {
    expect(decideDispatchComposition({ ...ALL_ON, selfModelRead: null })).toEqual({
      compose: false,
      reason: "no_self_model",
      logPayload: { attempted: false },
    });
  });

  it("★ the placeholder reason no_self_model_reader is GONE — no message mentions slice 2b", () => {
    expect((DISPATCH_REFUSAL_MESSAGES as Record<string, string>).no_self_model_reader).toBeUndefined();
    for (const message of Object.values(DISPATCH_REFUSAL_MESSAGES)) {
      expect(message).not.toMatch(/slice 2b/i);
    }
  });

  it("★ a dead session (no_session) NEVER produces a message that points at an admin", () => {
    // §3.2: a dead session is the most likely refusal in practice; pointing it at an admin
    // for a placement profile that is fine is the worst message available.
    expect(DISPATCH_REFUSAL_MESSAGES.no_session).not.toMatch(/admin/i);
    // ...whereas no_self_model DOES name the admin, because that is who fixes it.
    expect(DISPATCH_REFUSAL_MESSAGES.no_self_model).toMatch(/admin/i);
  });

  it("every refusal reason has a distinct operator-facing message", () => {
    const reasons: DispatchRefusalReason[] = [
      "no_provider",
      "dispatch_disabled",
      "no_worker_identity",
      "no_event_outbox_path",
      "no_session",
      "no_self_model",
    ];
    for (const reason of reasons) expect(DISPATCH_REFUSAL_MESSAGES[reason]).toBeTruthy();
    expect(new Set(Object.values(DISPATCH_REFUSAL_MESSAGES)).size).toBe(reasons.length);
  });
});

describe("WRK-010 slice 2 — shouldComposeSession (the weaker session-lifecycle gate) is UNCHANGED", () => {
  it("composes ONLY with a provider AND the flag on — never on the shipped default", () => {
    expect(shouldComposeSession({ provider: PROVIDER, dispatchEnabled: true })).toBe(true);
    expect(shouldComposeSession({ provider: PROVIDER, dispatchEnabled: false })).toBe(false);
    expect(shouldComposeSession({ provider: undefined, dispatchEnabled: true })).toBe(false);
  });
});

// DEP-011 Slice 2a — the networked `makeRunProvider` factory satisfies the provider gate.
const MAKE_RUN_PROVIDER = () => PROVIDER;

describe("DEP-011 Slice 2a — the provider gate accepts a makeRunProvider factory", () => {
  it("gate 1 — NEITHER provider NOR makeRunProvider ⇒ no_provider", () => {
    expect(
      decideDispatchComposition({ ...ALL_ON, provider: undefined, makeRunProvider: undefined }),
    ).toEqual({ compose: false, reason: "no_provider" });
  });

  it("a container worker with ONLY makeRunProvider (no desktop provider) passes the provider gate and composes", () => {
    expect(
      decideDispatchComposition({ ...ALL_ON, provider: undefined, makeRunProvider: MAKE_RUN_PROVIDER }),
    ).toEqual({ compose: true, selfModel: SELF });
  });

  it("shouldComposeSession composes on a makeRunProvider factory alone (the container lane)", () => {
    expect(shouldComposeSession({ provider: undefined, makeRunProvider: MAKE_RUN_PROVIDER, dispatchEnabled: true })).toBe(true);
    expect(shouldComposeSession({ provider: undefined, makeRunProvider: MAKE_RUN_PROVIDER, dispatchEnabled: false })).toBe(false);
    expect(shouldComposeSession({ provider: undefined, makeRunProvider: undefined, dispatchEnabled: true })).toBe(false);
  });
});
