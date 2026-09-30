// DEP-011 reaper Slice C — the /metrics arm of createProviderServer, over a loopback port.
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxProvider } from "@armyofagents/worker-daemon";
import { createProviderServer } from "../server.js";
import { accumulateReaperMetrics, createReaperMetrics } from "../reaper-metrics.js";

// The /metrics + /healthz arms never touch the provider, so a bare stub suffices (no e2b SDK).
const fakeProvider = {} as unknown as SandboxProvider;

let server: ReturnType<typeof createProviderServer> | null = null;

async function boot(opts: Parameters<typeof createProviderServer>[0]): Promise<string> {
  server = createProviderServer(opts);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("createProviderServer /metrics", () => {
  it("renders zeros when no reaper counter is wired", async () => {
    const baseUrl = await boot({ provider: fakeProvider });
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain('aoa_reaper_sandboxes_total{outcome="reaped"} 0');
    expect(body).toContain('aoa_reaper_sandboxes_total{outcome="failed"} 0');
  });

  it("renders the shared counter's accumulated tally", async () => {
    const reaperMetrics = createReaperMetrics();
    accumulateReaperMetrics(reaperMetrics, { reaped: 4, skipped: 1, unknown: 2, failed: 3 });
    const baseUrl = await boot({ provider: fakeProvider, reaperMetrics });
    const res = await fetch(`${baseUrl}/metrics`);
    const body = await res.text();
    expect(body).toContain('aoa_reaper_sandboxes_total{outcome="reaped"} 4');
    expect(body).toContain('aoa_reaper_sandboxes_total{outcome="skipped"} 1');
    expect(body).toContain('aoa_reaper_sandboxes_total{outcome="unknown"} 2');
    expect(body).toContain('aoa_reaper_sandboxes_total{outcome="failed"} 3');
  });

  it("keeps /healthz working alongside /metrics", async () => {
    const baseUrl = await boot({ provider: fakeProvider });
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("reflects live counter mutations (same ref shared with the loop)", async () => {
    const reaperMetrics = createReaperMetrics();
    const baseUrl = await boot({ provider: fakeProvider, reaperMetrics });
    // Mutate AFTER boot — the server holds the same ref, so /metrics sees it.
    accumulateReaperMetrics(reaperMetrics, { reaped: 9, skipped: 0, unknown: 0, failed: 0 });
    const body = await (await fetch(`${baseUrl}/metrics`)).text();
    expect(body).toContain('aoa_reaper_sandboxes_total{outcome="reaped"} 9');
  });
});
