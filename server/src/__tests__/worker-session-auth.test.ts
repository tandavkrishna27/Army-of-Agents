import { describe, expect, it } from "vitest";

async function sessionModule() {
  return import("../middleware/worker-session-auth.js").catch(() => null);
}

const key = "job-002-session-signing-key-at-least-32-bytes";
const claims = {
  aud: "device_session",
  sub: "73000000-0000-4000-8000-000000000001",
  organizationId: "71000000-0000-4000-8000-000000000001",
  targetId: "72000000-0000-4000-8000-000000000001",
  generation: 1,
  scope: "organization",
  deviceThumbprint: "a".repeat(64),
  profileHash: "b".repeat(64),
  iat: 1_786_320_000,
  exp: 1_786_320_900,
};

describe("JOB-002 signed worker session claims", () => {
  it("round-trips only the exact bounded audience/worker/target/generation/device claims", async () => {
    const mod = await sessionModule();
    expect(mod, "worker-session-auth module is not implemented").not.toBeNull();
    const token = mod!.createWorkerSessionToken(key, claims);
    expect(mod!.verifyWorkerSessionToken(key, token, new Date(claims.iat * 1000 + 1_000))).toEqual(claims);
  });

  it("rejects expiry, wrong audience, signature tamper, and a different verification key", async () => {
    const mod = await sessionModule();
    expect(mod, "worker-session-auth module is not implemented").not.toBeNull();
    const token = mod!.createWorkerSessionToken(key, claims);
    expect(() => mod!.verifyWorkerSessionToken(key, token, new Date((claims.exp + 1) * 1000))).toThrow(/worker session/i);
    expect(() => mod!.createWorkerSessionToken(key, { ...claims, aud: "worker_poll" })).toThrow(/worker session/i);
    expect(() => mod!.verifyWorkerSessionToken(key, `${token.slice(0, -1)}x`, new Date(claims.iat * 1000))).toThrow(/worker session/i);
    expect(() => mod!.verifyWorkerSessionToken("different-session-key-at-least-32-bytes", token, new Date(claims.iat * 1000))).toThrow(/worker session/i);
  });
});
