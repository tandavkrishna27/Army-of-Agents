// DAT-008 slice 2 — mapping stored handle rows onto the FROZEN wire ref.
//
// The mapper is deliberately dumb about validation: it shapes rows and lets
// `secretHandleRefSchema` (via `jobEnvelopeV1Schema.safeParse` in buildJobEnvelope)
// be the single authority on what is admissible. What IS tested here is that the
// shaping cannot smuggle a row past that authority — every row must arrive in a form
// the schema will actually judge, so a malformed row fails the envelope rather than
// being quietly dropped.

import { describe, expect, it } from "vitest";
import { secretHandleRefSchema } from "@armyofagents/worker-protocol";
import { toSecretHandleRefs } from "../services/execution-secret-handle-envelope.js";

const UUID = "11111111-2222-4333-8444-555555555555";
const UUID2 = "99999999-8888-4777-8666-555555555555";

const envRow = {
  handle: UUID,
  materialization: "env",
  materializationTarget: "ANTHROPIC_API_KEY",
  usePolicy: "sandbox_local_only",
};

describe("toSecretHandleRefs", () => {
  it("maps an env row onto a ref the frozen schema accepts", () => {
    const refs = toSecretHandleRefs([envRow]);
    expect(refs).toEqual([{
      handleId: UUID,
      materialization: { kind: "env", target: "ANTHROPIC_API_KEY" },
      usePolicy: "sandbox_local_only",
    }]);
    expect(secretHandleRefSchema.safeParse(refs[0]).success).toBe(true);
  });

  it("preserves row order so an envelope is stable across rebuilds", () => {
    const refs = toSecretHandleRefs([
      envRow,
      { ...envRow, handle: UUID2, materializationTarget: "OPENAI_API_KEY" },
    ]);
    expect(refs.map((ref) => ref.handleId)).toEqual([UUID, UUID2]);
  });

  it("maps a proxy row with NO target — the frozen proxy arm is strict and takes none", () => {
    const refs = toSecretHandleRefs([{
      handle: UUID, materialization: "proxy", materializationTarget: null, usePolicy: "fence_proxy",
    }]);
    expect(refs[0]!.materialization).toEqual({ kind: "proxy" });
    expect(secretHandleRefSchema.safeParse(refs[0]).success).toBe(true);
  });

  it("maps a file row with its sandbox path target", () => {
    const refs = toSecretHandleRefs([{
      handle: UUID,
      materialization: "file",
      materializationTarget: "/run/aoa/secrets/key",
      usePolicy: "sandbox_local_only",
    }]);
    expect(refs[0]!.materialization).toEqual({ kind: "file", target: "/run/aoa/secrets/key" });
  });

  it("does NOT drop a malformed row — it shapes it so the schema can reject it", () => {
    // The fail-closed direction is a rejected ENVELOPE (no lease), never a lease whose
    // sandbox silently has no credential. Dropping here would produce exactly that.
    const refs = toSecretHandleRefs([{ ...envRow, materializationTarget: null }]);
    expect(refs).toHaveLength(1);
    expect(secretHandleRefSchema.safeParse(refs[0]).success).toBe(false);
  });

  it.each([
    ["a non-uuid handle", { ...envRow, handle: "provider:anthropic" }],
    ["an unknown materialization kind", { ...envRow, materialization: "smuggled" }],
    ["a null materialization", { ...envRow, materialization: null }],
    ["a null use policy", { ...envRow, usePolicy: null }],
    ["env paired with the fence proxy", { ...envRow, usePolicy: "fence_proxy" }],
    ["proxy carrying a target", {
      handle: UUID, materialization: "proxy", materializationTarget: "X", usePolicy: "fence_proxy",
    }],
  ])("keeps %s in the output so the envelope fails closed", (_label, row) => {
    const refs = toSecretHandleRefs([row]);
    expect(refs).toHaveLength(1);
    expect(secretHandleRefSchema.safeParse(refs[0]).success).toBe(false);
  });

  it("returns an empty array for no rows — the pre-DAT-008 envelope, unchanged", () => {
    expect(toSecretHandleRefs([])).toEqual([]);
  });
});
