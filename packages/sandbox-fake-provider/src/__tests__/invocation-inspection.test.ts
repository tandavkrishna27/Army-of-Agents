import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createFakeSandboxProvider,
  loadFixtureFromDir,
  startControlServer,
  type StartedControlServer,
} from "../index.js";

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "distributed-execution",
);

describe("networked invocation inspection", () => {
  let started: StartedControlServer;

  beforeEach(async () => {
    started = await startControlServer(createFakeSandboxProvider(), { fixturesDir: FIXTURES_DIR });
  });
  afterEach(async () => {
    await started.close();
  });

  const post = async (route: string, body: unknown) => {
    const res = await fetch(`${started.url}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("addresses a fake by providerId, scripts a fixture, replays, and reads the exact ledger", async () => {
    const script = await post("/script", { providerId: "prov-A", fixtureId: "batch-success" });
    expect(script.status).toBe(200);
    expect(script.body.ok).toBe(true);

    const replay = await post("/replay", { providerId: "prov-A" });
    expect(replay.status).toBe(200);
    const replayResult = replay.body.result as { invocations: Array<Record<string, unknown>> };

    const res = await fetch(`${started.url}/invocations?providerId=prov-A`);
    const ledger = (await res.json()) as Array<Record<string, unknown>>;

    // The GET /invocations ledger equals the replay's reported ledger, byte-for-byte.
    expect(JSON.stringify(ledger)).toBe(JSON.stringify(replayResult.invocations));
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger[0].op).toBe("create");
    expect(ledger[0].checkpoint).toBe("create");
    // Each entry carries the full ledger shape.
    for (const entry of ledger) {
      expect(Object.keys(entry).sort()).toEqual(
        ["argsDigest", "checkpoint", "faultInjected", "op", "providerId", "seq", "ts"].sort(),
      );
      expect(entry.providerId).toBe("prov-A");
    }
    // reconcile_cleanup is present in the teardown → zero resources afterward.
    expect(ledger.some((e) => e.op === "reconcile_cleanup")).toBe(true);
  });

  it("rejects an unknown provider operation (fail-closed 400)", async () => {
    const res = await post("/invoke", { providerId: "prov-B", op: "not_a_real_op", args: {} });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("unknown provider operation");
  });

  it("rejects an unschema-valid fixture fail-closed rather than partially scripting it", async () => {
    const raw = (await loadFixtureFromDir(FIXTURES_DIR, "batch-success")) as Record<string, unknown>;
    const events = raw.expectedEvents as Array<Record<string, unknown>>;
    (events[0].payload as Record<string, unknown>).injected = "tamper"; // breaks the stored digest

    const res = await post("/script", { providerId: "prov-C", fixture: raw });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toContain("digest verification");

    // Nothing was scripted → a replay for that provider is refused.
    const replay = await post("/replay", { providerId: "prov-C" });
    expect(replay.status).toBe(400);
  });

  it("reset clears the networked ledger", async () => {
    await post("/script", { providerId: "prov-D", fixtureId: "batch-cancel-during-execution" });
    await post("/replay", { providerId: "prov-D" });
    const before = (await (await fetch(`${started.url}/invocations`)).json()) as unknown[];
    expect(before.length).toBeGreaterThan(0);

    const reset = await post("/reset", {});
    expect(reset.status).toBe(200);

    const after = (await (await fetch(`${started.url}/invocations`)).json()) as unknown[];
    expect(after).toEqual([]);
  });
});
