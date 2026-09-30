import { afterEach, describe, expect, it } from "vitest";

import { assertLoopbackHost, startHealthServer, type HealthServerHandle } from "../health/health-server.js";
import { createMetrics } from "../metrics/metrics.js";

const openHandles: HealthServerHandle[] = [];

afterEach(async () => {
  while (openHandles.length > 0) {
    const handle = openHandles.pop();
    if (handle) await handle.close();
  }
});

async function get(port: number, pathname: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return { status: res.status, body: await res.text() };
}

describe("assertLoopbackHost", () => {
  it("accepts numeric loopback hosts", () => {
    expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
    expect(() => assertLoopbackHost("::1")).not.toThrow();
  });
  it("rejects non-loopback hosts and the remappable name 'localhost'", () => {
    expect(() => assertLoopbackHost("0.0.0.0")).toThrow(/loopback/i);
    expect(() => assertLoopbackHost("10.0.0.5")).toThrow(/loopback/i);
    // 'localhost' is a name a hosts-file could remap → not accepted (numeric only).
    expect(() => assertLoopbackHost("localhost")).toThrow(/loopback/i);
  });
});

describe("startHealthServer", () => {
  it("binds loopback and serves /healthz + payload-free /metrics", async () => {
    const metrics = createMetrics();
    metrics.setWorkerUp(true);
    const handle = await startHealthServer({ host: "127.0.0.1", port: 0 }, metrics);
    openHandles.push(handle);

    expect(handle.port).toBeGreaterThan(0);

    const health = await get(handle.port, "/healthz");
    expect(health.status).toBe(200);

    const scrape = await get(handle.port, "/metrics");
    expect(scrape.status).toBe(200);
    expect(scrape.body).toContain("worker_up");
    // Payload-free: no tenant/secret content, no obvious identity fields.
    expect(scrape.body).not.toMatch(/organization|company|jobId|secret|token|private/i);

    const missing = await get(handle.port, "/nope");
    expect(missing.status).toBe(404);
  });

  it("rejects a non-loopback bind host before opening a socket", async () => {
    const metrics = createMetrics();
    await expect(startHealthServer({ host: "0.0.0.0", port: 0 }, metrics)).rejects.toThrow(/loopback/i);
  });
});

describe("DSK-003 — GET /instance, the stale-pid defence's live half", () => {
  // `resolveTargetProcess` refuses to hand a control command a pid unless the LIVE host
  // reports the same per-boot instanceId as the state record. This is the endpoint it
  // asks. A random nonce is not tenant data, so it belongs in the same read-only
  // category as /healthz — it identifies WHICH process is listening, nothing about it.

  it("serves the instance id when the host was started with one", async () => {
    const metrics = createMetrics();
    const instanceId = "11111111-1111-4111-8111-111111111111";
    const handle = await startHealthServer({ host: "127.0.0.1", port: 0, instanceId }, metrics);
    openHandles.push(handle);

    const res = await get(handle.port, "/instance");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ instanceId });
  });

  it("404s when no instance id was configured — the prior behaviour is the default", async () => {
    const handle = await startHealthServer({ host: "127.0.0.1", port: 0 }, createMetrics());
    openHandles.push(handle);
    expect((await get(handle.port, "/instance")).status).toBe(404);
  });

  it("discloses ONLY the instance id", async () => {
    // The endpoint is unauthenticated by design, like /healthz. It must therefore stay a
    // nonce echo and never grow into a status surface carrying identity or config.
    const instanceId = "22222222-2222-4222-8222-222222222222";
    const handle = await startHealthServer({ host: "127.0.0.1", port: 0, instanceId }, createMetrics());
    openHandles.push(handle);
    const body = JSON.parse((await get(handle.port, "/instance")).body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["instanceId"]);
  });

  it("still refuses a non-loopback bind with an instance id set", async () => {
    // Adding a route must not have created a path around the H-06 network boundary.
    await expect(
      startHealthServer({ host: "0.0.0.0", port: 0, instanceId: "x" }, createMetrics()),
    ).rejects.toThrow(/loopback/i);
  });

  it("does not answer /instance for a non-GET method", async () => {
    const instanceId = "33333333-3333-4333-8333-333333333333";
    const handle = await startHealthServer({ host: "127.0.0.1", port: 0, instanceId }, createMetrics());
    openHandles.push(handle);
    const res = await fetch(`http://127.0.0.1:${handle.port}/instance`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
