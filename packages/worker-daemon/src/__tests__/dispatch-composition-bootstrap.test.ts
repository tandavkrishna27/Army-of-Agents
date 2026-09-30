// WRK-008 slice 2 — the daemon SAYS why it is not dispatching.
//
// ★ THIS SUITE EXISTS BECAUSE THE DECISION FUNCTION BEING CORRECT PROVES NOTHING ABOUT
// THE DAEMON. `decideDispatchComposition` is unit- and mutation-tested, but a pure
// function nobody calls is this programme's signature defect, and it has now been found
// four times. These tests boot the real `bootstrapWorkerDaemon` and assert the reason
// reaches a real logger — so "wired" is an observation, not a claim.
//
// Before this, a worker that took no work was SILENT: the health server said "up", the
// process stayed alive, and an operator had nothing to act on.

import { describe, expect, it, vi } from "vitest";

import { bootstrapWorkerDaemon, type ProcessLike } from "../bin/worker-daemon.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import type { Env } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import type { HealthServerHandle } from "../health/health-server.js";

function baseEnv(overrides: Env = {}): Env {
  return {
    AOA_WORKER_CONTROL_PLANE_URL: "https://control.example.com",
    AOA_WORKER_ENROLLMENT_CODE_FILE: "/run/secrets/enrollment-code",
    AOA_WORKER_KEY_STORE_MODE: "mounted_secret",
    AOA_WORKER_TARGET_SCOPE: "organization",
    ...overrides,
  };
}

/** Captures structured log records so the REASON can be asserted, not just the text. */
function recordingLogger() {
  const records: Array<{ fields: unknown; message: unknown }> = [];
  const logger: Logger = {
    info: (fields: unknown, message?: unknown) => { records.push({ fields, message }); },
    warn: () => {},
    error: () => {},
    flush: async () => {},
  } as unknown as Logger;
  return { records, logger };
}

const handle = { close: async () => {} } as unknown as HealthServerHandle;
const proc: ProcessLike = { once: () => {}, exit: () => {} };

async function boot(env: Env, provider?: ReturnType<typeof createFakeSandboxProvider>) {
  const { records, logger } = recordingLogger();
  await bootstrapWorkerDaemon({
    env,
    proc,
    provider,
    createLogger: () => logger,
    startHealth: vi.fn(async () => handle) as never,
  } as never);
  const reasons = records
    .map((r) => (r.fields as { reason?: string } | undefined)?.reason)
    .filter((r): r is string => typeof r === "string");
  return { records, reasons };
}

describe("WRK-008 slice 2 — the daemon reports why it does not dispatch", () => {
  it("★ the SHIPPED shape (no provider injected) reports no_provider", async () => {
    // This is `bootstrapWorkerDaemon({ env, proc })` — the real production invocation.
    // Dispatch is off by construction, and now it says so instead of being silent.
    const { reasons } = await boot(baseEnv());
    expect(reasons).toContain("no_provider");
  });

  it("★ a provider-bearing host with the flag OFF reports dispatch_disabled", async () => {
    // The row that makes the flag non-vacuous. Unreachable for the shipped binary, so it
    // is reached the only way it can be: by injecting a provider.
    const { reasons } = await boot(baseEnv(), createFakeSandboxProvider({}));
    expect(reasons).toContain("dispatch_disabled");
  });

  it("★ flag ON + provider still refuses — and names the BUILD (no device identity), not the operator", async () => {
    // ★ slice 2b: `no_self_model_reader` is RETIRED. This boot is `mounted_secret` with no
    // injected custody stores, so the enrolment block never runs and gate 3 fires:
    // `no_worker_identity` — a build/packaging fact — NOT `no_self_model`, which would send
    // someone to an admin for a placement profile that may already be set.
    const { reasons } = await boot(
      baseEnv({ AOA_WORKER_DISPATCH_ENABLED: "1" }),
      createFakeSandboxProvider({}),
    );
    expect(reasons).toContain("no_worker_identity");
    expect(reasons).not.toContain("no_self_model");
    expect(reasons).not.toContain("no_self_model_reader");
  });

  it("the reason is a structured FIELD, not only prose in the message", async () => {
    // An operator grepping logs, and any future log-based alert, needs the machine-
    // readable reason. Prose alone would make this observable only by a human reading it.
    const { records } = await boot(baseEnv());
    const record = records.find((r) => (r.fields as { reason?: string } | undefined)?.reason);
    expect(record).toBeDefined();
    expect(typeof record?.message).toBe("string");
  });
});
