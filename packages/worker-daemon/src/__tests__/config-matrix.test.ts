import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "../config/config.js";
import type { Env } from "../config/env.js";

function baseEnv(overrides: Env = {}): Env {
  return {
    AOA_WORKER_CONTROL_PLANE_URL: "https://control.example.com",
    AOA_WORKER_ENROLLMENT_CODE_FILE: "/run/secrets/enrollment-code",
    AOA_WORKER_KEY_STORE_MODE: "mounted_secret",
    AOA_WORKER_TARGET_SCOPE: "organization",
    ...overrides,
  };
}

/** No thrown reason may echo a secret value. */
const SECRET_CANARY = "s3cr3t-enrollment-code-value";

describe("loadWorkerConfig — invalid rows throw with a bounded reason", () => {
  const invalidRows: Array<{ name: string; env: Env; match: RegExp }> = [
    {
      name: "absent control-plane URL",
      env: baseEnv({ AOA_WORKER_CONTROL_PLANE_URL: undefined }),
      match: /control.plane/i,
    },
    {
      name: "blank control-plane URL",
      env: baseEnv({ AOA_WORKER_CONTROL_PLANE_URL: "   " }),
      match: /control.plane/i,
    },
    {
      name: "non-absolute control-plane URL",
      env: baseEnv({ AOA_WORKER_CONTROL_PLANE_URL: "control.example.com/path" }),
      match: /control.plane|absolute|url/i,
    },
    {
      name: "non-http control-plane scheme",
      env: baseEnv({ AOA_WORKER_CONTROL_PLANE_URL: "ftp://control.example.com" }),
      match: /http|scheme|control.plane/i,
    },
    {
      name: "invalid key-store enum",
      env: baseEnv({ AOA_WORKER_KEY_STORE_MODE: "vault" }),
      match: /AOA_WORKER_KEY_STORE_MODE/,
    },
    {
      name: "invalid target-scope enum",
      env: baseEnv({ AOA_WORKER_TARGET_SCOPE: "galaxy" }),
      match: /AOA_WORKER_TARGET_SCOPE/,
    },
    {
      name: "unparseable concurrency integer",
      env: baseEnv({ AOA_WORKER_CONCURRENCY_BATCH: "lots" }),
      match: /AOA_WORKER_CONCURRENCY_BATCH/,
    },
    {
      name: "out-of-range concurrency integer",
      env: baseEnv({ AOA_WORKER_CONCURRENCY_BATCH: "100000" }),
      match: /AOA_WORKER_CONCURRENCY_BATCH|range/,
    },
    {
      name: "unparseable poll timeout",
      env: baseEnv({ AOA_WORKER_POLL_TIMEOUT_MS: "soon" }),
      match: /AOA_WORKER_POLL_TIMEOUT_MS/,
    },
    {
      name: "out-of-unit backoff jitter",
      env: baseEnv({ AOA_WORKER_BACKOFF_JITTER: "2" }),
      match: /AOA_WORKER_BACKOFF_JITTER|\[0, 1\]/,
    },
    {
      name: "backoff max below base",
      env: baseEnv({ AOA_WORKER_BACKOFF_BASE_MS: "5000", AOA_WORKER_BACKOFF_MAX_MS: "1000" }),
      match: /backoff|max|base/i,
    },
    {
      name: "non-loopback health host",
      env: baseEnv({ AOA_WORKER_HEALTH_HOST: "0.0.0.0" }),
      match: /loopback/i,
    },
    {
      name: "public health host",
      env: baseEnv({ AOA_WORKER_HEALTH_HOST: "10.0.0.5" }),
      match: /loopback/i,
    },
    {
      name: "invalid health port",
      env: baseEnv({ AOA_WORKER_HEALTH_PORT: "99999" }),
      match: /AOA_WORKER_HEALTH_PORT|range/,
    },
    {
      name: "no enrollment-code source at all",
      env: baseEnv({ AOA_WORKER_ENROLLMENT_CODE_FILE: undefined }),
      match: /enrollment.code/i,
    },
    {
      name: "both enrollment-code sources set (inconsistent)",
      env: baseEnv({ AOA_WORKER_ENROLLMENT_CODE_ENV: "AOA_WORKER_ENROLLMENT_CODE" }),
      match: /enrollment.code|inconsistent|exactly one/i,
    },
  ];

  // E4-D10: keyStoreMode (custody) and targetScope are ORTHOGONAL — every
  // custody/scope combination is accepted at config load; scope validity is the
  // control plane's job at enrollment. These were previously (wrongly) rejected.
  for (const [keyStoreMode, targetScope] of [
    ["os_keychain", "organization"],
    ["os_keychain", "platform"],
    ["mounted_secret", "owner"],
  ] as const) {
    it(`accepts orthogonal custody/scope: ${keyStoreMode} + ${targetScope}`, () => {
      const config = loadWorkerConfig(
        baseEnv({ AOA_WORKER_KEY_STORE_MODE: keyStoreMode, AOA_WORKER_TARGET_SCOPE: targetScope }),
      );
      expect(config.keyStoreMode).toBe(keyStoreMode);
      expect(config.targetScope).toBe(targetScope);
    });
  }

  for (const row of invalidRows) {
    it(`rejects: ${row.name}`, () => {
      expect(() => loadWorkerConfig(row.env)).toThrow(row.match);
    });
  }

  it("never echoes a secret value in a thrown reason", () => {
    // The enrollment-code SOURCE is a file path here; even if a raw code leaked
    // into env, an invalid-config throw must not contain it.
    const env = baseEnv({
      AOA_WORKER_CONTROL_PLANE_URL: "not-a-url",
      AOA_WORKER_ENROLLMENT_CODE: SECRET_CANARY,
    });
    let message = "";
    try {
      loadWorkerConfig(env);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(SECRET_CANARY);
  });
});
