import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "../config/config.js";
import type { Env } from "../config/env.js";

/** A minimal valid environment (mounted-secret container worker). */
function baseEnv(overrides: Env = {}): Env {
  return {
    AOA_WORKER_CONTROL_PLANE_URL: "https://control.example.com",
    AOA_WORKER_ENROLLMENT_CODE_FILE: "/run/secrets/enrollment-code",
    AOA_WORKER_KEY_STORE_MODE: "mounted_secret",
    AOA_WORKER_TARGET_SCOPE: "organization",
    ...overrides,
  };
}

describe("loadWorkerConfig — happy path", () => {
  it("parses a complete valid environment into a frozen config", () => {
    const config = loadWorkerConfig(
      baseEnv({
        AOA_WORKER_CONCURRENCY_BATCH: "3",
        AOA_WORKER_CONCURRENCY_BROWSER: "2",
        AOA_WORKER_CONCURRENCY_SERVICE: "1",
        AOA_WORKER_POLL_TIMEOUT_MS: "25000",
        AOA_WORKER_BACKOFF_BASE_MS: "500",
        AOA_WORKER_BACKOFF_MAX_MS: "20000",
        AOA_WORKER_BACKOFF_JITTER: "0.25",
        AOA_WORKER_HEALTH_HOST: "127.0.0.1",
        AOA_WORKER_HEALTH_PORT: "9500",
      }),
    );

    expect(config.controlPlaneBaseUrl).toBe("https://control.example.com");
    expect(config.enrollmentCodeSource).toEqual({ kind: "path", path: "/run/secrets/enrollment-code" });
    expect(config.keyStoreMode).toBe("mounted_secret");
    expect(config.targetScope).toBe("organization");
    expect(config.concurrency).toEqual({ batch: 3, browser: 2, service: 1 });
    expect(config.pollTimeoutMs).toBe(25000);
    expect(config.backoff).toEqual({ baseMs: 500, maxMs: 20000, jitter: 0.25 });
    expect(config.health).toEqual({ host: "127.0.0.1", port: 9500 });
  });

  it("applies defaults for optional fields and freezes the result deeply", () => {
    const config = loadWorkerConfig(baseEnv());
    // Concurrency defaults to the teaching default of 1 slot per workload class.
    expect(config.concurrency).toEqual({ batch: 1, browser: 1, service: 1 });
    expect(config.pollTimeoutMs).toBeGreaterThan(0);
    expect(config.backoff.baseMs).toBeGreaterThan(0);
    expect(config.backoff.maxMs).toBeGreaterThanOrEqual(config.backoff.baseMs);
    expect(config.backoff.jitter).toBeGreaterThanOrEqual(0);
    expect(config.backoff.jitter).toBeLessThanOrEqual(1);
    // Health binds loopback by default.
    expect(config.health.host).toBe("127.0.0.1");

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.concurrency)).toBe(true);
    expect(Object.isFrozen(config.backoff)).toBe(true);
    expect(Object.isFrozen(config.health)).toBe(true);
  });

  it("accepts the env-var enrollment-code source form", () => {
    const config = loadWorkerConfig(
      baseEnv({
        AOA_WORKER_ENROLLMENT_CODE_FILE: undefined,
        AOA_WORKER_ENROLLMENT_CODE_ENV: "AOA_WORKER_ENROLLMENT_CODE",
      }),
    );
    expect(config.enrollmentCodeSource).toEqual({ kind: "env", envVar: "AOA_WORKER_ENROLLMENT_CODE" });
  });

  it("accepts an os_keychain desktop worker at any scope (custody ⊥ scope, E4-D10)", () => {
    for (const targetScope of ["owner", "organization", "platform"] as const) {
      const config = loadWorkerConfig(
        baseEnv({ AOA_WORKER_KEY_STORE_MODE: "os_keychain", AOA_WORKER_TARGET_SCOPE: targetScope }),
      );
      expect(config.keyStoreMode).toBe("os_keychain");
      expect(config.targetScope).toBe(targetScope);
    }
  });
});

describe("loadWorkerConfig — never reads a database URL", () => {
  it("ignores a set DATABASE_URL and *_DATABASE_URL entirely", () => {
    const config = loadWorkerConfig(
      baseEnv({
        DATABASE_URL: "postgres://u:p@db:5432/x",
        AOA_APP_DATABASE_URL: "postgres://u:p@db:5432/app",
        AOA_OPERATOR_DATABASE_URL: "postgres://u:p@db:5432/op",
      }),
    );
    // No database field is produced, and the presence of DB URLs is not required.
    expect(config).not.toHaveProperty("databaseUrl");
    expect(JSON.stringify(config)).not.toContain("postgres://");
  });

  it("does not require any database URL to load", () => {
    expect(() => loadWorkerConfig(baseEnv())).not.toThrow();
  });
});
