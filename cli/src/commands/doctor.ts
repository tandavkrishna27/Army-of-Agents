import * as p from "@clack/prompts";
import pc from "picocolors";
import type { AoaConfig } from "../config/schema.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import {
  agentJwtSecretCheck,
  configCheck,
  databaseCheck,
  deploymentAuthCheck,
  llmCheck,
  logCheck,
  portCheck,
  secretsCheck,
  storageCheck,
  type CheckResult,
} from "../checks/index.js";
import { runDoctorLint } from "../checks/lint-runner.js";
import { printAoaCliBanner } from "../utils/banner.js";

const STATUS_ICON = {
  pass: pc.green("✓"),
  warn: pc.yellow("!"),
  fail: pc.red("✗"),
} as const;

export async function doctor(opts: {
  config?: string;
  lint?: boolean;
  json?: boolean;
  offline?: boolean;
  repair?: boolean;
  yes?: boolean;
}): Promise<{ passed: number; warned: number; failed: number }> {
  if (!opts.json) {
    printAoaCliBanner();
    p.intro(pc.bgCyan(pc.black(" aoa doctor ")));
  }

  if (opts.lint) {
    const { results, report } = await runDoctorLint(opts);
    for (const result of results) {
      if (!opts.json) printResult(result);
    }
    const summary = finishDoctor(results, opts);
    if (report.summary.errorCount > 0) {
      process.exitCode = 1;
    }
    return summary;
  }

  const configPath = resolveConfigPath(opts.config);
  const results: CheckResult[] = [];

  // 1. Config check (must pass before others)
  const cfgResult = configCheck(opts.config);
  results.push(cfgResult);
  if (!opts.json) printResult(cfgResult);

  if (cfgResult.status === "fail") {
    return finishDoctor(results, opts);
  }

  let config: AoaConfig;
  try {
    config = readConfig(opts.config)!;
  } catch (err) {
    const readResult: CheckResult = {
      name: "Config file",
      status: "fail",
      message: `Could not read config: ${err instanceof Error ? err.message : String(err)}`,
      canRepair: false,
      repairHint: "Run `aoa configure --section database` or `aoa onboard`",
    };
    results.push(readResult);
    if (!opts.json) printResult(readResult);
    return finishDoctor(results, opts);
  }

  // 2. Deployment/auth mode check
  const deploymentAuthResult = deploymentAuthCheck(config);
  results.push(deploymentAuthResult);
  if (!opts.json) printResult(deploymentAuthResult);

  // 3. Agent JWT check
  const jwtResult = agentJwtSecretCheck(opts.config);
  results.push(jwtResult);
  if (!opts.json) printResult(jwtResult);
  await maybeRepair(jwtResult, opts);

  // 4. Secrets adapter check
  const secretsResult = secretsCheck(config, configPath);
  results.push(secretsResult);
  if (!opts.json) printResult(secretsResult);
  await maybeRepair(secretsResult, opts);

  // 5. Storage check
  const storageResult = storageCheck(config, configPath);
  results.push(storageResult);
  if (!opts.json) printResult(storageResult);
  await maybeRepair(storageResult, opts);

  // 6. Database check
  const dbResult = opts.offline
    ? offlineSkipped("Database")
    : await databaseCheck(config, configPath);
  results.push(dbResult);
  if (!opts.json) printResult(dbResult);
  await maybeRepair(dbResult, opts);

  // 7. LLM check
  const llmResult = opts.offline ? offlineSkipped("LLM provider") : await llmCheck(config);
  results.push(llmResult);
  if (!opts.json) printResult(llmResult);

  // 8. Log directory check
  const logResult = logCheck(config, configPath);
  results.push(logResult);
  if (!opts.json) printResult(logResult);
  await maybeRepair(logResult, opts);

  // 9. Port check
  const portResult = opts.offline ? offlineSkipped("Server port") : await portCheck(config);
  results.push(portResult);
  if (!opts.json) printResult(portResult);

  // Summary
  return finishDoctor(results, opts);
}

function offlineSkipped(name: string): CheckResult {
  return {
    name,
    status: "warn",
    message: "Skipped because --offline was requested.",
    canRepair: false,
  };
}

export function formatDoctorJson(results: CheckResult[], offline = false) {
  const summary = summarize(results);
  return {
    schemaVersion: 1,
    command: "aoa doctor",
    offline,
    status: summary.failed > 0 ? "failed" : summary.warned > 0 ? "needs_attention" : "healthy",
    summary,
    checks: results.map(({ name, status, message, repairHint }) => ({
      name,
      status,
      message,
      ...(repairHint ? { repairHint } : {}),
    })),
  };
}

function finishDoctor(
  results: CheckResult[],
  opts: { json?: boolean; offline?: boolean },
): { passed: number; warned: number; failed: number } {
  const summary = summarize(results);
  if (opts.json) {
    console.log(JSON.stringify(formatDoctorJson(results, Boolean(opts.offline)), null, 2));
  } else {
    printSummary(results);
  }
  return summary;
}

function summarize(results: CheckResult[]): { passed: number; warned: number; failed: number } {
  return {
    passed: results.filter((r) => r.status === "pass").length,
    warned: results.filter((r) => r.status === "warn").length,
    failed: results.filter((r) => r.status === "fail").length,
  };
}

function printResult(result: CheckResult): void {
  const icon = STATUS_ICON[result.status];
  p.log.message(`${icon} ${pc.bold(result.name)}: ${result.message}`);
  if (result.status !== "pass" && result.repairHint) {
    p.log.message(`  ${pc.dim(result.repairHint)}`);
  }
}

async function maybeRepair(
  result: CheckResult,
  opts: { repair?: boolean; yes?: boolean; json?: boolean },
): Promise<void> {
  if (result.status === "pass" || !result.canRepair || !result.repair) return;
  if (!opts.repair || opts.json) return;

  let shouldRepair = opts.yes;
  if (!shouldRepair) {
    const answer = await p.confirm({
      message: `Repair "${result.name}"?`,
      initialValue: true,
    });
    if (p.isCancel(answer)) return;
    shouldRepair = answer;
  }

  if (shouldRepair) {
    try {
      await result.repair();
      p.log.success(`Repaired: ${result.name}`);
    } catch (err) {
      p.log.error(`Repair failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function printSummary(results: CheckResult[]): { passed: number; warned: number; failed: number } {
  const { passed, warned, failed } = summarize(results);

  const parts: string[] = [];
  parts.push(pc.green(`${passed} passed`));
  if (warned) parts.push(pc.yellow(`${warned} warnings`));
  if (failed) parts.push(pc.red(`${failed} failed`));

  p.note(parts.join(", "), "Summary");

  if (failed > 0) {
    p.outro(pc.red("Some checks failed. Fix the issues above and re-run doctor."));
  } else if (warned > 0) {
    p.outro(pc.yellow("All critical checks passed with some warnings."));
  } else {
    p.outro(pc.green("All checks passed!"));
  }

  return { passed, warned, failed };
}
