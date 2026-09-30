import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerHelloV1 } from "@armyofagents/worker-protocol";

import { readWorkerSelfModel } from "../identity/self-model-read.js";
import { SessionTerminalError, type SessionProvider } from "../poll/poll-loop.js";
import { buildDesktopHello } from "../enrollment/desktop-hello.js";
import { startFakeControlPlane, type FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollFixtureWorker, enrollmentCodeConfig } from "./support/poll-fixtures.js";
import type { WorkerSession } from "../enrollment/enroll.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../tests/fixtures/worker-provisioned-target.json", import.meta.url)),
    "utf8",
  ),
) as { registeredProfile: Record<string, unknown>; providerConstraintProfile: Record<string, unknown> };

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const CODE = "self-model-read-code";

const REPORT: WorkerHelloV1 = buildDesktopHello({
  workerId: "00000000-0000-4000-8000-000000000001",
  targetId: fixture.registeredProfile.targetId as string,
  deviceGeneration: 1,
  platform: "linux",
  arch: "x64",
});

let fake: FakeControlPlane;
beforeEach(async () => {
  fake = await startFakeControlPlane({ enrollments: [enrollmentCodeConfig(CODE)] });
});
afterEach(async () => {
  await fake.close();
});

/** A controllable SessionProvider around a real enrolled session, so the HTTP + proof are
 * real but recover() and the terminal case are observable. */
function provider(session: WorkerSession): { p: SessionProvider; recoverCalls: () => number } {
  let recovers = 0;
  return {
    p: {
      get: async () => session,
      recover: async () => {
        recovers += 1;
        return session;
      },
    },
    recoverCalls: () => recovers,
  };
}

function okDirective() {
  return {
    kind: "ok" as const,
    registeredProfile: fixture.registeredProfile,
    providerConstraintProfile: fixture.providerConstraintProfile,
    selfModelHash: "a".repeat(64),
  };
}

describe("readWorkerSelfModel.component — real socket, real proof", () => {
  it("POSITIVE CONTROL: a live 200 assembles a BRANDED model whose report is the one passed in", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueueSelfModel(okDirective());
    const { p } = provider(session);

    const result = await readWorkerSelfModel({ client, session: p, key, report: REPORT, sha256Fn: sha256 });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    // identity, not a copy — the report is carried through verbatim.
    expect(result.selfModel.report).toBe(REPORT);
    expect(result.selfModel.registeredTargetProfile.targetId).toBe(fixture.registeredProfile.targetId);
  });

  it("the proof is signed over the SAME path the request is sent to (the fake verifies independently)", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueueSelfModel(okDirective());
    const { p } = provider(session);
    await readWorkerSelfModel({ client, session: p, key, report: REPORT, sha256Fn: sha256 });
    const rec = fake.requests.find((r) => r.url.includes("/self/placement-profile"));
    expect(rec?.status).toBe(200);
    expect(rec?.deviceThumbprint).toBe(key.deviceThumbprint);
  });

  it("a TAMPERED provider profile fails the brand — refused{unassemblable}, not degraded", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueueSelfModel({
      ...okDirective(),
      providerConstraintProfile: { ...fixture.providerConstraintProfile, maxIdleSeconds: 999999 },
    });
    const { p } = provider(session);
    const result = await readWorkerSelfModel({ client, session: p, key, report: REPORT, sha256Fn: sha256 });
    expect(result).toEqual({ kind: "refused", reason: "unassemblable" });
  });

  it("a 401 asks the provider to recover exactly ONCE, then succeeds", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueueSelfModel({ kind: "unauthorized" });
    fake.enqueueSelfModel(okDirective());
    const { p, recoverCalls } = provider(session);
    const result = await readWorkerSelfModel({ client, session: p, key, report: REPORT, sha256Fn: sha256 });
    expect(result.kind).toBe("ok");
    expect(recoverCalls()).toBe(1);
  });

  it("a 404 is no_profile — distinct from a transport failure", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueueSelfModel({ kind: "error", status: 404 });
    const { p } = provider(session);
    const result = await readWorkerSelfModel({ client, session: p, key, report: REPORT, sha256Fn: sha256 });
    expect(result).toEqual({ kind: "refused", reason: "no_profile" });
  });

  it("a terminal session yields session_terminal, NOT no_profile", async () => {
    const { key, client } = await enrollFixtureWorker(fake, CODE);
    const p: SessionProvider = {
      get: async () => {
        throw new SessionTerminalError();
      },
      recover: async () => {
        throw new SessionTerminalError();
      },
    };
    const result = await readWorkerSelfModel({ client, session: p, key, report: REPORT, sha256Fn: sha256 });
    expect(result).toEqual({ kind: "refused", reason: "session_terminal" });
  });

  it("★ NOTHING THROWS on a garbage 200 body — refused{unassemblable}", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueueSelfModel({ kind: "ok", registeredProfile: { nope: true }, providerConstraintProfile: {}, selfModelHash: "a".repeat(64) });
    const { p } = provider(session);
    const result = await readWorkerSelfModel({ client, session: p, key, report: REPORT, sha256Fn: sha256 });
    expect(result).toEqual({ kind: "refused", reason: "unassemblable" });
  });
});
