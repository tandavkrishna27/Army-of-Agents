import fs from "node:fs";
import type { HealthCategory, HealthFinding, HealthReport } from "@armyofagents/shared";
import type { AoaConfig } from "../config/schema.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import {
  agentJwtSecretCheck,
  configCheck,
  deploymentAuthCheck,
  portCheck,
  secretsCheck,
  type CheckResult,
} from "./index.js";
import { resolveRuntimeLikePath } from "./path-resolver.js";

export interface DoctorLintOptions {
  config?: string;
}

export interface DoctorLintResult {
  report: HealthReport;
  results: CheckResult[];
}

const CATEGORY_BY_CHECK_NAME: Record<string, HealthCategory> = {
  "Agent JWT secret": "auth",
  "Config file": "setup",
  Database: "database",
  "Deployment/auth mode": "auth",
  "LLM provider": "setup",
  "Log directory": "runtime",
  "Server port": "runtime",
  "Secrets adapter": "security",
  Storage: "storage",
};

export async function runDoctorLint(opts: DoctorLintOptions = {}): Promise<DoctorLintResult> {
  const checkedAt = new Date().toISOString();
  const configPath = resolveConfigPath(opts.config);
  const results: CheckResult[] = [];

  const cfgResult = configCheck(opts.config);
  results.push(stripRepair(cfgResult));

  if (cfgResult.status === "fail") {
    return buildLintResult(results, checkedAt);
  }

  let config: AoaConfig;
  try {
    config = readConfig(opts.config)!;
  } catch (err) {
    results.push({
      name: "Config file",
      status: "fail",
      message: `Could not read config: ${err instanceof Error ? err.message : String(err)}`,
      canRepair: false,
      repairHint: "Run `aoa configure --section database` or `aoa onboard`",
    });
    return buildLintResult(results, checkedAt);
  }

  results.push(stripRepair(deploymentAuthCheck(config)));
  results.push(stripRepair(agentJwtSecretCheck(opts.config)));
  results.push(stripRepair(secretsCheck(config, configPath)));
  results.push(storageLintCheck(config, configPath));
  results.push(databaseLintCheck(config, configPath));
  results.push(llmLintCheck(config));
  results.push(logLintCheck(config, configPath));
  results.push(stripRepair(await portCheck(config)));

  return buildLintResult(results, checkedAt);
}

function buildLintResult(results: CheckResult[], checkedAt: string): DoctorLintResult {
  const findings = results.map((result) => checkResultToFinding(result, checkedAt));
  const summary = {
    errorCount: findings.filter((finding) => finding.severity === "error").length,
    warningCount: findings.filter((finding) => finding.severity === "warning").length,
    infoCount: findings.filter((finding) => finding.severity === "info").length,
    checkedAt,
  };

  return {
    results,
    report: {
      scope: "instance",
      status: summary.errorCount > 0 ? "critical" : summary.warningCount > 0 ? "needs_attention" : "healthy",
      summary,
      findings,
      sections: {
        platform: {
          cli: {
            mode: "lint",
            checkedAt,
            readOnly: true,
          },
        },
      },
    },
  };
}

function checkResultToFinding(result: CheckResult, checkedAt: string): HealthFinding {
  const severity = result.status === "fail" ? "error" : result.status === "warn" ? "warning" : "info";
  return {
    id: `doctor-lint-${slugify(result.name)}`,
    scope: "instance",
    category: CATEGORY_BY_CHECK_NAME[result.name] ?? "setup",
    severity,
    title: result.name,
    message: result.message,
    fixHint: result.repairHint,
    source: "cli",
    checkCode: `doctor.${slugify(result.name)}`,
    detectedAt: checkedAt,
  };
}

function stripRepair(result: CheckResult): CheckResult {
  return {
    name: result.name,
    status: result.status,
    message: result.message,
    canRepair: false,
    repairHint: result.repairHint,
  };
}

function databaseLintCheck(config: AoaConfig, configPath?: string): CheckResult {
  if (config.database.mode === "postgres") {
    if (!config.database.connectionString) {
      return {
        name: "Database",
        status: "fail",
        message: "PostgreSQL mode selected but no connection string configured",
        canRepair: false,
        repairHint: "Run `aoa configure --section database`",
      };
    }

    return {
      name: "Database",
      status: "pass",
      message: "PostgreSQL connection string is configured; network validation is skipped in --lint",
    };
  }

  if (config.database.mode === "embedded-postgres") {
    const dataDir = resolveRuntimeLikePath(config.database.embeddedPostgresDataDir, configPath);
    if (!fs.existsSync(dataDir)) {
      return {
        name: "Database",
        status: "warn",
        message: `Embedded PostgreSQL data directory does not exist yet: ${dataDir}`,
        canRepair: false,
        repairHint: "Start AoA once or run `aoa doctor --repair` to initialize runtime directories",
      };
    }

    return {
      name: "Database",
      status: "pass",
      message: `Embedded PostgreSQL data directory exists: ${dataDir}`,
    };
  }

  return {
    name: "Database",
    status: "fail",
    message: `Unknown database mode: ${String(config.database.mode)}`,
    canRepair: false,
    repairHint: "Run `aoa configure --section database`",
  };
}

function storageLintCheck(config: AoaConfig, configPath?: string): CheckResult {
  if (config.storage.provider === "local_disk") {
    const baseDir = resolveRuntimeLikePath(config.storage.localDisk.baseDir, configPath);
    if (!fs.existsSync(baseDir)) {
      return {
        name: "Storage",
        status: "warn",
        message: `Local disk storage directory does not exist yet: ${baseDir}`,
        canRepair: false,
        repairHint: "Start AoA once or run `aoa doctor --repair` to initialize runtime directories",
      };
    }

    try {
      fs.accessSync(baseDir, fs.constants.W_OK);
      return {
        name: "Storage",
        status: "pass",
        message: `Local disk storage is writable: ${baseDir}`,
      };
    } catch {
      return {
        name: "Storage",
        status: "fail",
        message: `Local storage directory is not writable: ${baseDir}`,
        canRepair: false,
        repairHint: "Check file permissions for storage.localDisk.baseDir",
      };
    }
  }

  const bucket = config.storage.s3.bucket.trim();
  const region = config.storage.s3.region.trim();
  if (!bucket || !region) {
    return {
      name: "Storage",
      status: "fail",
      message: "S3 storage requires non-empty bucket and region",
      canRepair: false,
      repairHint: "Run `aoa configure --section storage`",
    };
  }

  return {
    name: "Storage",
    status: "warn",
    message: `S3 storage configured (bucket=${bucket}, region=${region}). Reachability check is skipped in --lint.`,
    canRepair: false,
    repairHint: "Verify credentials and endpoint in deployment environment",
  };
}

function logLintCheck(config: AoaConfig, configPath?: string): CheckResult {
  const logDir = resolveRuntimeLikePath(config.logging.logDir, configPath);
  if (!fs.existsSync(logDir)) {
    return {
      name: "Log directory",
      status: "warn",
      message: `Log directory does not exist yet: ${logDir}`,
      canRepair: false,
      repairHint: "Start AoA once or run `aoa doctor --repair` to initialize runtime directories",
    };
  }

  try {
    fs.accessSync(logDir, fs.constants.W_OK);
    return {
      name: "Log directory",
      status: "pass",
      message: `Log directory is writable: ${logDir}`,
    };
  } catch {
    return {
      name: "Log directory",
      status: "fail",
      message: `Log directory is not writable: ${logDir}`,
      canRepair: false,
      repairHint: "Check file permissions on the log directory",
    };
  }
}

function llmLintCheck(config: AoaConfig): CheckResult {
  if (!config.llm) {
    return {
      name: "LLM provider",
      status: "pass",
      message: "No LLM provider configured (optional)",
    };
  }

  if (!config.llm.apiKey) {
    return {
      name: "LLM provider",
      status: "pass",
      message: `${config.llm.provider} configured but no API key set (optional)`,
    };
  }

  return {
    name: "LLM provider",
    status: "pass",
    message: `${config.llm.provider} API key is configured; external validation is skipped in --lint`,
  };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
