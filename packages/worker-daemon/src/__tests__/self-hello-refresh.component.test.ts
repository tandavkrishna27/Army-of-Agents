import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerHelloV1 } from "@armyofagents/worker-protocol";

import { refreshSelfHello } from "../identity/self-hello-refresh.js";
import { buildDesktopHello } from "../enrollment/desktop-hello.js";
import { startFakeControlPlane, type FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollFixtureWorker, enrollmentCodeConfig } from "./support/poll-fixtures.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../tests/fixtures/worker-provisioned-target.json", import.meta.url)),
    "utf8",
  ),
) as { registeredProfile: Record<string, unknown> };

const CODE = "self-hello-refresh-code";
const HELLO: WorkerHelloV1 = buildDesktopHello({
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

describe("refreshSelfHello.component — real socket, real proof", () => {
  it("a 200 refresh returns a FRESH session (new token) bound to the same worker/target", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueueSelfHello({ kind: "refreshed" });
    const result = await refreshSelfHello({ client, current: session, key, hello: HELLO });
    expect(result).not.toBeNull();
    expect(result!.token).not.toBe(session.token);
    expect(result!.workerId).toBe(session.workerId);
    expect(result!.targetId).toBe(session.targetId);
    const rec = fake.requests.find((r) => r.url.includes("/self/hello"));
    expect(rec?.status).toBe(200);
    expect(rec?.deviceThumbprint).toBe(key.deviceThumbprint);
  });

  it("a 204 unchanged returns the CURRENT session (no mint)", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueueSelfHello({ kind: "unchanged" });
    const result = await refreshSelfHello({ client, current: session, key, hello: HELLO });
    expect(result).toBe(session);
  });

  it("★ a refusal returns null (best-effort) — never throws", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueueSelfHello({ kind: "unauthorized" });
    const result = await refreshSelfHello({ client, current: session, key, hello: HELLO });
    expect(result).toBeNull();
  });
});
