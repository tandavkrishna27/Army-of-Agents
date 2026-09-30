import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

// FND-005: loadConfig now resolves the distributed-execution deployment flag and
// asserts hosted-execution startup safety, so the four execution-policy env vars
// (plus the deployment mode a couple of cases set) are saved/restored alongside
// the pre-existing ones to keep each case isolated.
const EXECUTION_POLICY_ENV_KEYS = [
  "AOA_TRUST_PROXY",
  "AOA_EMBEDDED_POSTGRES_PORT",
  "AOA_DEPLOYMENT_MODE",
  "AOA_DISTRIBUTED_EXECUTION_ENABLED",
  "AOA_APP_DATABASE_URL",
  "AOA_OPERATOR_DATABASE_URL",
  "AOA_DISTRIBUTED_PUBLIC_SERVICE_INGRESS_ENABLED",
  "AOA_DISTRIBUTED_CLOUD_PLUGIN_EXECUTION_ENABLED",
  "AOA_ALLOW_UNSANDBOXED_MULTITENANT",
  "AOA_STORAGE_S3_ENDPOINT",
  "AOA_STORAGE_S3_PRESIGN_ENDPOINT",
] as const;

const ORIGINAL_EXECUTION_POLICY_ENV: Record<string, string | undefined> = Object.fromEntries(
  EXECUTION_POLICY_ENV_KEYS.map((key) => [key, process.env[key]]),
);

describe("loadConfig", () => {
  beforeEach(() => {
    for (const key of EXECUTION_POLICY_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of EXECUTION_POLICY_ENV_KEYS) {
      const original = ORIGINAL_EXECUTION_POLICY_ENV[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  describe("trustProxy", () => {
    it("defaults to false when env var is unset", () => {
      expect(loadConfig().trustProxy).toBe(false);
    });

    it("defaults to false when env var is empty string", () => {
      process.env.AOA_TRUST_PROXY = "";
      expect(loadConfig().trustProxy).toBe(false);
    });

    it("parses true as true", () => {
      process.env.AOA_TRUST_PROXY = "true";
      expect(loadConfig().trustProxy).toBe(true);
    });

    it("parses false as false", () => {
      process.env.AOA_TRUST_PROXY = "false";
      expect(loadConfig().trustProxy).toBe(false);
    });

    it("parses integer string as number hop count", () => {
      process.env.AOA_TRUST_PROXY = "2";
      expect(loadConfig().trustProxy).toBe(2);
    });

    it("parses comma-separated CIDR list as array", () => {
      process.env.AOA_TRUST_PROXY = "10.0.0.0/8,192.168.0.0/16";
      expect(loadConfig().trustProxy).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
    });

    it("trims whitespace in CIDR list entries", () => {
      process.env.AOA_TRUST_PROXY = " 10.0.0.0/8 , 192.168.0.0/16 ";
      expect(loadConfig().trustProxy).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
    });

    it("rejects malformed input with an error naming the env var", () => {
      process.env.AOA_TRUST_PROXY = "not-a-number-or-cidr";
      expect(() => loadConfig()).toThrow(/AOA_TRUST_PROXY/);
    });
  });

  describe("embeddedPostgresPort", () => {
    it("allows an explicit embedded Postgres port env override", () => {
      process.env.AOA_EMBEDDED_POSTGRES_PORT = "55429";
      expect(loadConfig().embeddedPostgresPort).toBe(55429);
    });

    it("rejects an invalid embedded Postgres port env override", () => {
      process.env.AOA_EMBEDDED_POSTGRES_PORT = "not-a-port";
      expect(() => loadConfig()).toThrow(/AOA_EMBEDDED_POSTGRES_PORT/);
    });
  });

  describe("distributed execution", () => {
    it("defaults off", () => {
      delete process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED;
      expect(loadConfig().distributedExecutionEnabled).toBe(false);
    });

    it("parses an explicit deployment enablement", () => {
      process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = "true";
      process.env.AOA_APP_DATABASE_URL = "postgres://aoa_app:secret@localhost/aoa";
      process.env.AOA_OPERATOR_DATABASE_URL = "postgres://aoa_operator:secret@localhost/aoa";
      expect(loadConfig().distributedExecutionEnabled).toBe(true);
    });

    it.each([
      ["AOA_APP_DATABASE_URL", "AOA_OPERATOR_DATABASE_URL"],
      ["AOA_OPERATOR_DATABASE_URL", "AOA_APP_DATABASE_URL"],
    ])("fails closed when flag-on startup is missing %s", (missing, present) => {
      process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = "true";
      process.env[present] =
        present === "AOA_APP_DATABASE_URL"
          ? "postgres://aoa_app:secret@localhost/aoa"
          : "postgres://aoa_operator:secret@localhost/aoa";
      delete process.env[missing];
      expect(() => loadConfig()).toThrow(new RegExp(missing));
    });

    it("does not require either non-owner URL while the strangler flag is off", () => {
      process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = "false";
      delete process.env.AOA_APP_DATABASE_URL;
      delete process.env.AOA_OPERATOR_DATABASE_URL;
      expect(loadConfig().distributedExecutionEnabled).toBe(false);
    });

    it("refuses cloud_auth with the unsafe process-wide execution override", () => {
      process.env.AOA_DEPLOYMENT_MODE = "cloud_auth";
      process.env.AOA_ALLOW_UNSANDBOXED_MULTITENANT = "1";
      expect(() => loadConfig()).toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT.*cloud_auth/i);
    });

    it.each([
      "AOA_DISTRIBUTED_PUBLIC_SERVICE_INGRESS_ENABLED",
      "AOA_DISTRIBUTED_CLOUD_PLUGIN_EXECUTION_ENABLED",
    ])("refuses the excluded surface %s instead of silently enabling it", (name) => {
      process.env[name] = "true";
      expect(() => loadConfig()).toThrow(new RegExp(`${name}.*excluded`, "i"));
    });
  });

  describe("s3 endpoints", () => {
    // Regression for the staging artifact-transfer-grant 503: a blank
    // AOA_STORAGE_S3_ENDPOINT / _PRESIGN_ENDPOINT (the AWS, non-MinIO case) must
    // resolve to undefined (use the AWS default host), never "" — a "" reaches the
    // S3 presign path and is rejected as "not https".
    it("coerces a blank AOA_STORAGE_S3_ENDPOINT to undefined", () => {
      process.env.AOA_STORAGE_S3_ENDPOINT = "";
      expect(loadConfig().storageS3Endpoint).toBeUndefined();
    });

    it("coerces a whitespace AOA_STORAGE_S3_PRESIGN_ENDPOINT to undefined", () => {
      process.env.AOA_STORAGE_S3_PRESIGN_ENDPOINT = "   ";
      expect(loadConfig().storageS3PresignEndpoint).toBeUndefined();
    });

    it("passes a real endpoint through, trimmed", () => {
      process.env.AOA_STORAGE_S3_ENDPOINT = " https://minio.local:9000 ";
      expect(loadConfig().storageS3Endpoint).toBe("https://minio.local:9000");
    });
  });
});
