// WRK-008 slice 2b Step 8a — the CONTAINER boot root still refuses.
//
// The Wave-4 plan named this the largest single risk in the wave: composing the loop turns
// dispatch on for every daemon running the build the moment it merges. 2a showed the risk did
// not arise because no provider could be acquired; 2b adds the missing pieces, so the question
// is live again and deserves an ARTIFACT rather than an argument. The env is read from
// `docker-compose.d1.yml`, so it cannot drift.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { bootstrapWorkerDaemon, type BootstrapDeps } from "../bin/worker-daemon.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { generateDeviceKey, exportDevicePrivateKeyPkcs8Der } from "../identity/device-key.js";

const composePath = fileURLToPath(new URL("../../../../docker-compose.d1.yml", import.meta.url));

/** Extract a service's `environment:` block from the compose file — genuinely parsed, so a
 * value drift (or a hardcoded env) is caught by the fixture assertion below. */
function d1WorkerEnv(service: string): Record<string, string> {
  const lines = readFileSync(composePath, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start < 0) throw new Error(`service ${service} not found in compose file`);
  const env: Record<string, string> = {};
  let inEnv = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^  \S/.test(line)) break; // next 2-space service — done
    if (/^    environment:\s*$/.test(line)) { inEnv = true; continue; }
    if (inEnv && /^    \S/.test(line)) break; // next 4-space key under the service — env done
    if (inEnv) {
      const m = /^      ([A-Z0-9_]+):\s*"?([^"#]*?)"?\s*$/.exec(line);
      if (m) env[m[1]!] = m[2]!;
    }
  }
  return env;
}

function bootDeps(env: Record<string, string>, over: Partial<BootstrapDeps> = {}) {
  const records: Array<{ fields: Record<string, unknown> }> = [];
  const composeDispatch = vi.fn(async () => { throw new Error("composeDispatch must not be reached"); });
  const exitCodes: number[] = [];
  const deps = {
    env,
    proc: { once: () => {}, exit: (c: number) => exitCodes.push(c) },
    createLogger: () => ({ info: (f: Record<string, unknown>) => records.push({ fields: f }), warn: () => {}, error: (f: Record<string, unknown>) => records.push({ fields: f }), flush: async () => {} }),
    startHealth: async () => ({ port: 1, close: async () => {} }),
    composeDispatch,
    ...over,
  } as unknown as BootstrapDeps;
  return { deps, composeDispatch, exitCodes, reasons: () => records.map((r) => (r.fields as { reason?: string }).reason).filter((r): r is string => typeof r === "string") };
}

describe("shipped-binary-refuses (8a) — the container root", () => {
  it("the parsed D1 env is REAL — and the two workers DIFFER, so nothing here asserts its own fixture", () => {
    // Guards the "hardcode d1WorkerEnv" mutant: a hardcoded env would assert its own values.
    //
    // WRK-017 made this STRONGER rather than merely updating a constant. The two workers now
    // carry DIFFERENT custody modes — worker-a `mounted_secret` (the negative control),
    // worker-b `file_record` (the enrolling worker) — so a hardcoded parser cannot satisfy both
    // arms with one value, which is a sharper anti-fixture property than the previous "both are
    // mounted_secret". Dispatch stays off for BOTH, which is what this file is actually about.
    expect(d1WorkerEnv("worker-a").AOA_WORKER_KEY_STORE_MODE).toBe("mounted_secret");
    expect(d1WorkerEnv("worker-b").AOA_WORKER_KEY_STORE_MODE).toBe("file_record");
    expect(d1WorkerEnv("worker-a").AOA_WORKER_DISPATCH_ENABLED).toBeUndefined();
    expect(d1WorkerEnv("worker-b").AOA_WORKER_DISPATCH_ENABLED).toBeUndefined();
    expect(d1WorkerEnv("worker-a").AOA_WORKER_SANDBOX_PROVIDER).toBeUndefined();
    expect(d1WorkerEnv("worker-b").AOA_WORKER_SANDBOX_PROVIDER).toBeUndefined();
  });

  it("the REAL production invocation refuses — composeDispatch at 0 calls", async () => {
    const { deps, composeDispatch } = bootDeps(d1WorkerEnv("worker-a"));
    await bootstrapWorkerDaemon(deps);
    expect(composeDispatch).not.toHaveBeenCalled();
  });

  it("worker-a refuses with EXACTLY no_provider", async () => {
    const { deps, reasons } = bootDeps(d1WorkerEnv("worker-a"));
    await bootstrapWorkerDaemon(deps);
    expect(reasons()).toEqual(["no_provider"]);
  });

  // WRK-017 split worker-b out of the shared `it.each`, and the split is the point rather than
  // bookkeeping: worker-b's env now REQUIRES the container host, so the two halves of that
  // coupling are separately observable here, in the daemon, where the refusal actually happens.
  it("worker-b's env under the DAEMON bin refuses at CUSTODY, pre-socket — the crash loop", async () => {
    // This is the state a partial revert produces: `file_record` in `environment:` with the
    // compose `command:` override gone, so the image CMD enters `bin/worker-daemon.js`, which
    // injects NO record stores. `resolveCustody` refuses before any socket and the process
    // exits 1 — `up --wait` then reports only "unhealthy service".
    // `checkWorkerCustodyBootRoot` (scripts/lib/d1-compose-invariants.mjs) forbids that compose
    // state statically; this is the daemon-side proof that the refusal is real.
    const { deps, reasons, exitCodes } = bootDeps(d1WorkerEnv("worker-b"));
    await bootstrapWorkerDaemon(deps);
    expect(reasons()).toEqual(["keyStoreMode is file_record but no identity store was injected"]);
    expect(exitCodes).toEqual([1]);
  });

  it("worker-b WITH the container host's stores gets past custody and refuses EXACTLY no_provider", async () => {
    // What `runContainerHost` actually composes: both record stores injected. Custody passes,
    // enrolment is stubbed (this file is about DISPATCH, not the network), and the daemon then
    // refuses for the reason that matters — no provider. Without this arm the assertion above
    // would leave "worker-b never dispatches" resting on a custody refusal rather than on the
    // dispatch gate, which is a different claim.
    const store = { load: () => null, saveIfAbsent: () => "stored" as const, clear: () => {} };
    const { deps, reasons, exitCodes } = bootDeps(d1WorkerEnv("worker-b"), {
      identityStore: store as never,
      receiptStore: store as never,
      enrollOnceFn: (async () => ({
        enrolled: true, minted: true, skipped: false,
        workerId: "00000000-0000-4000-8000-000000000002",
        targetId: "22222222-2222-4222-8222-222222222222",
        deviceGeneration: 1, deviceThumbprint: "tp",
      })) as never,
    });
    await bootstrapWorkerDaemon(deps);
    expect(reasons()).toEqual(["no_provider"]);
    expect(exitCodes).toEqual([]);
  });

  it("D1 with the flag FORCED ON still refuses (no provider)", async () => {
    const { deps, reasons } = bootDeps({ ...d1WorkerEnv("worker-a"), AOA_WORKER_DISPATCH_ENABLED: "1" });
    await bootstrapWorkerDaemon(deps);
    expect(reasons()).toEqual(["no_provider"]);
  });

  it("D1 + a provider + the flag STILL refuses — no_worker_identity (mounted_secret, no stores)", async () => {
    const { deps, reasons } = bootDeps(
      { ...d1WorkerEnv("worker-a"), AOA_WORKER_DISPATCH_ENABLED: "1", AOA_WORKER_EVENT_OUTBOX_PATH: "/tmp/o.db" },
      { provider: createFakeSandboxProvider({}) },
    );
    await bootstrapWorkerDaemon(deps);
    expect(reasons()).toContain("no_worker_identity");
  });

  it("★ POSITIVE CONTROL: the SAME composeDispatch spy IS reached once every gate is satisfied", async () => {
    // Without this the four refusal assertions would pass against an UNREACHABLE spy — "provably
    // inert" would be indistinguishable from "never wired". Full gates: os_keychain + stores +
    // provider + flag + outbox + a live session + a self-model.
    const { deps, composeDispatch } = bootDeps(
      { AOA_WORKER_CONTROL_PLANE_URL: "https://cp", AOA_WORKER_ENROLLMENT_CODE_ENV: "C", C: "x", AOA_WORKER_KEY_STORE_MODE: "os_keychain", AOA_WORKER_TARGET_SCOPE: "organization", AOA_WORKER_DISPATCH_ENABLED: "1", AOA_WORKER_EVENT_OUTBOX_PATH: "/tmp/o.db" },
      {
        provider: createFakeSandboxProvider({}),
        identityStore: { load: () => ({ v: 1, workerId: "00000000-0000-4000-8000-000000000001", targetId: "b0000000-0000-4000-8000-000000000003", deviceGeneration: 1, privateKeyPkcs8Der: exportDevicePrivateKeyPkcs8Der(generateDeviceKey()) }), save: () => {}, clear: () => {} } as never,
        receiptStore: { load: () => null, save: () => {}, clear: () => {} } as never,
        enrollOnceFn: (async () => ({ skipped: true, workerId: "w", targetId: "t", deviceGeneration: 1, deviceThumbprint: "tp" })) as never,
        createLifecycleFn: (() => ({ store: { current: () => ({ token: "s", workerId: "w", targetId: "t", deviceGeneration: 1, obtainedAtMs: 0, ttlMs: 1, expiresAtMs: 1 }), ensureFresh: async () => ({ token: "s" }), forceRefresh: async () => ({ token: "s" }), isStopped: () => false, set: () => {} }, onSessionMinted: () => {} })) as never,
        composeDispatch: vi.fn(async () => ({ leasing: { stopLeasing: () => {}, drain: async () => {} }, renewal: { stop: () => {} }, eventOutbox: { stopDrain: () => {}, flush: async () => {}, closeStore: () => {} }, self: {} as never, measure: () => ({}) as never, loopSupervisorSeam: { accept: () => {} }, limiter: {} as never, start: () => {}, pollLoop: {} as never })),
      },
    );
    // Give the read a live self-model so gate 6 passes.
    const fullDeps = { ...deps, createClient: () => ({ baseUrl: "http://f", selfModelReadPath: "/api/execution-targets/self/placement-profile", selfHelloRefreshPath: "/api/execution-targets/self/hello", selfModelRead: async () => ({ status: 200, body: readFixture() }), selfHelloRefresh: async () => ({ status: 200, body: {}, sessionHeader: "s2" }), heartbeatPath: "/api/execution-targets/heartbeat", heartbeat: async () => ({ status: 204 }) }) } as unknown as BootstrapDeps;
    await bootstrapWorkerDaemon(fullDeps);
    expect(fullDeps.composeDispatch).toHaveBeenCalledTimes(1);
  });
});

function readFixture() {
  const f = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../tests/fixtures/worker-provisioned-target.json", import.meta.url)), "utf8")) as { registeredProfile: unknown; providerConstraintProfile: unknown };
  return { registeredProfile: f.registeredProfile, providerConstraintProfile: f.providerConstraintProfile };
}
