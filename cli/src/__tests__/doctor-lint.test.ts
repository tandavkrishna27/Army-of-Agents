import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AoaConfig } from "../config/schema.js";
import { runDoctorLint } from "../checks/lint-runner.js";

const ORIGINAL_ENV = { ...process.env };

function createTempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-doctor-lint-"));
  const configPath = path.join(dir, "config.json");
  const runtimeDir = path.join(dir, "runtime");
  const config: AoaConfig = {
    $meta: {
      version: 1,
      updatedAt: new Date("2026-05-25T00:00:00.000Z").toISOString(),
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(runtimeDir, "db"),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(runtimeDir, "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(runtimeDir, "logs"),
    },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 54321,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "auto",
    },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: path.join(runtimeDir, "storage") },
      s3: {
        bucket: "aoa",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: true,
      localEncrypted: { keyFilePath: path.join(runtimeDir, "secrets", "master.key") },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { configPath, runtimeDir };
}

describe("runDoctorLint", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.AOA_AGENT_JWT_SECRET = "test-agent-secret";
    process.env.AOA_SECRETS_MASTER_KEY = "0123456789abcdef0123456789abcdef";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns an instance health report without creating runtime directories", async () => {
    const { configPath, runtimeDir } = createTempConfig();

    const { report, results } = await runDoctorLint({ config: configPath });

    expect(report.scope).toBe("instance");
    expect(report.status).toBe("needs_attention");
    expect(report.summary.warningCount).toBeGreaterThanOrEqual(3);
    expect(results.every((result) => result.canRepair !== true && !result.repair)).toBe(true);
    expect(fs.existsSync(runtimeDir)).toBe(false);
  });
});
