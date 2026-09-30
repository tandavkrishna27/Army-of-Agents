/**
 * DSK-003 Lane A — the composition root: the host state record's lifecycle.
 *
 * Everything else in the control surface decides; this is where the decisions become
 * reachable. Two orderings carry the weight:
 *
 *   WRITE AFTER the health server is listening. The record advertises a port, and the
 *   stale-pid defence probes that port to confirm the instance. A record published before
 *   the socket exists advertises something that cannot answer.
 *
 *   REMOVE LAST, after the health server closes. While the host is draining, `status`
 *   should still be able to find it — the same reason `stop-host` is last in the uninstall
 *   plan. Once health is closed a probe fails and `drain` refuses, which is the correct
 *   answer for a host already shutting down.
 *
 * The instanceId is generated ONCE per boot and given to both the record and the health
 * server. If those two ever disagreed, the defence would reject the very host that wrote
 * the record — a self-inflicted denial that no unit test of either half would catch.
 */

import { describe, expect, it, vi } from "vitest";

import { bootstrapWorkerDaemon } from "../bin/worker-daemon.js";
import type { HealthServerHandle } from "../health/health-server.js";

/**
 * `mounted_secret` deliberately: it is the mode every deployed compose file uses, and it
 * skips the DSK-001 enrolment block, so a bootstrap reaches the health server and the
 * state record without needing a keystore or a control plane.
 */
function baseEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    AOA_WORKER_CONTROL_PLANE_URL: "https://control.example.com",
    // Config requires an enrolment code in EVERY mode, not only os_keychain.
    AOA_WORKER_ENROLLMENT_CODE_ENV: "AOA_TICKET",
    AOA_TICKET: "aoa_enr_abcdefgh12345678.0123456789abcdef0123456789abcdef",
    AOA_WORKER_KEY_STORE_MODE: "mounted_secret",
    AOA_WORKER_TARGET_SCOPE: "organization",
    AOA_WORKER_HEALTH_HOST: "127.0.0.1",
    AOA_WORKER_HEALTH_PORT: "9000",
    ...over,
  };
}

function fakeProc() {
  const exitCodes: number[] = [];
  const handlers = new Map<string, () => void>();
  return {
    exitCodes,
    handlers,
    proc: {
      exit: (code: number) => { exitCodes.push(code); },
      once: (sig: string, fn: () => void) => { handlers.set(sig, fn); },
      on: () => {},
    } as never,
  };
}

const silentLogger = () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => silentLogger(), flush: () => {},
}) as never;

/** Drive a bootstrap with the health server and state writer both recorded. */
function harness(over: Record<string, unknown> = {}) {
  const events: string[] = [];
  let healthConfig: { instanceId?: string } | undefined;
  const handle = {
    port: 45678,
    close: async () => { events.push("health-close"); },
  } as unknown as HealthServerHandle;

  const writeHostState = vi.fn(async (record: { instanceId: string; healthPort: number }) => {
    events.push(`write-state:${record.instanceId}:${record.healthPort}`);
  });
  const removeHostState = vi.fn(async () => { events.push("remove-state"); });

  return {
    events,
    writeHostState,
    removeHostState,
    healthConfigSeen: () => healthConfig,
    args: {
      env: baseEnv(),
      createLogger: silentLogger,
      startHealth: (async (config: { instanceId?: string }) => {
        healthConfig = config;
        events.push("health-start");
        return handle;
      }) as never,
      writeHostState: writeHostState as never,
      removeHostState: removeHostState as never,
      ...over,
    },
  };
}

describe("DSK-003 — the state record is written after health is listening", () => {
  it("writes AFTER health-start, never before", async () => {
    const h = harness();
    const { proc } = fakeProc();
    const result = await bootstrapWorkerDaemon({ ...h.args, proc } as never);
    expect(result.ok).toBe(true);

    const healthAt = h.events.indexOf("health-start");
    const writeAt = h.events.findIndex((e) => e.startsWith("write-state:"));
    expect(healthAt).toBeGreaterThan(-1);
    expect(writeAt, "the record was never written").toBeGreaterThan(-1);
    expect(writeAt, "the record advertised a port before the socket existed")
      .toBeGreaterThan(healthAt);
  });

  it("records the ACTUAL bound port, not the CONFIGURED one", async () => {
    // The two are deliberately different here: config asks for 9000, the listener reports
    // 45678. A record carrying the configured value would send every control command to a
    // port nothing is listening on. (Config rejects port 0 — the health server accepts it,
    // the config loader does not — so the distinction is made with two real ports.)
    const h = harness();
    const { proc } = fakeProc();
    await bootstrapWorkerDaemon({ ...h.args, proc } as never);
    expect(h.events.some((e) => e.endsWith(":45678")), "recorded the configured port")
      .toBe(true);
    expect(h.events.some((e) => e.endsWith(":9000"))).toBe(false);
  });

  it("gives the SAME instance id to the record and the health server", async () => {
    // If these disagreed, the stale-pid defence would reject the very host that wrote
    // the record — and no unit test of either half alone would notice.
    const h = harness();
    const { proc } = fakeProc();
    await bootstrapWorkerDaemon({ ...h.args, proc } as never);

    const written = h.events.find((e) => e.startsWith("write-state:"))!.split(":")[1];
    expect(written).toBeTruthy();
    expect(h.healthConfigSeen()?.instanceId).toBe(written);
  });

  it("generates a DIFFERENT instance id on each boot", async () => {
    // A constant nonce would make the defence vacuous: any recycled pid on a host that
    // had ever run would match.
    const seen = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const h = harness();
      const { proc } = fakeProc();
      await bootstrapWorkerDaemon({ ...h.args, proc } as never);
      seen.add(h.events.find((e) => e.startsWith("write-state:"))!.split(":")[1]!);
    }
    expect(seen.size).toBe(5);
  });
});

describe("DSK-003 — the record is removed on shutdown, last", () => {
  it("removes the record AFTER the health server closes", async () => {
    const h = harness();
    const { proc, handlers } = fakeProc();
    const result = await bootstrapWorkerDaemon({ ...h.args, proc } as never);
    expect(result.ok).toBe(true);

    await result.shutdown!("SIGTERM");

    const closeAt = h.events.indexOf("health-close");
    const removeAt = h.events.indexOf("remove-state");
    expect(closeAt).toBeGreaterThan(-1);
    expect(removeAt, "the record was never removed — a stale record would outlive the host")
      .toBeGreaterThan(-1);
    expect(removeAt).toBeGreaterThan(closeAt);
    expect(handlers.has("SIGTERM")).toBe(true);
  });

  it("still boots when no state writer is supplied — the container path is unchanged", async () => {
    // Every deployed compose file bootstraps without a desktop host. Making the writer
    // required would break them; it is optional and absent by default.
    const h = harness({ writeHostState: undefined, removeHostState: undefined });
    const { proc } = fakeProc();
    const result = await bootstrapWorkerDaemon({ ...h.args, proc } as never);
    expect(result.ok).toBe(true);
    expect(h.events.some((e) => e.startsWith("write-state:"))).toBe(false);
    await result.shutdown!("SIGTERM");
    expect(h.events).toContain("health-close");
  });

  it("does not pass an instance id to health when no writer is configured", async () => {
    // No record means nothing to probe against, so /instance must stay 404 and the
    // surface stays byte-identical to the pre-DSK-003 container.
    const h = harness({ writeHostState: undefined, removeHostState: undefined });
    const { proc } = fakeProc();
    await bootstrapWorkerDaemon({ ...h.args, proc } as never);
    expect(h.healthConfigSeen()?.instanceId).toBeUndefined();
  });
});
