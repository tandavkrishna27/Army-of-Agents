import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterEnvironmentCheck, AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@armyofagents/adapter-utils";
import { parseObject } from "@armyofagents/adapter-utils/server-utils";
import { DEFAULT_MODEL } from "../index.js";

const execFileAsync = promisify(execFile);
const str = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const command = str(config.hermesCommand) ?? str(config.command) ?? "hermes";
  const checks: AdapterEnvironmentCheck[] = [];
  try {
    const { stdout, stderr } = await execFileAsync(command, ["--version"], { timeout: 10_000 });
    const version = (stdout || stderr).trim();
    checks.push({ level: version ? "info" : "warn", code: version ? "hermes_version" : "hermes_version_unknown", message: version ? `Hermes Agent version: ${version}` : "Could not determine Hermes Agent version" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    checks.push({ level: "error", code: code === "ENOENT" ? "hermes_cli_not_found" : "hermes_version_failed", message: code === "ENOENT" ? `Hermes CLI "${command}" not found in PATH` : `Hermes CLI probe failed: ${error instanceof Error ? error.message : String(error)}`, hint: "Install Hermes Agent and check the configured command." });
  }
  if (!checks.some((check) => check.level === "error")) {
    try {
      const { stdout, stderr } = await execFileAsync(process.platform === "win32" ? "python" : "python3", ["--version"], { timeout: 5_000 });
      const version = (stdout || stderr).trim();
      const match = /(\d+)\.(\d+)/.exec(version);
      if (match && (Number(match[1]) < 3 || Number(match[1]) === 3 && Number(match[2]) < 10))
        checks.push({ level: "error", code: "hermes_python_old", message: `Python ${version} found — Hermes requires Python 3.10+` });
    } catch {
      checks.push({ level: "warn", code: "hermes_python_missing", message: "Python 3.10+ was not found in PATH" });
    }
    checks.push({ level: "info", code: str(config.model) ? "hermes_model_configured" : "hermes_default_model", message: `Model: ${str(config.model) ?? DEFAULT_MODEL}` });
    if (!["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"].some((key) => Boolean(process.env[key])))
      checks.push({ level: "warn", code: "hermes_no_api_keys", message: "No model API keys found in environment", hint: "Hermes may have credentials in its local configuration." });
  }
  return { adapterType: "hermes_local", status: checks.some((check) => check.level === "error") ? "fail" : checks.some((check) => check.level === "warn") ? "warn" : "pass", checks, testedAt: new Date().toISOString() };
}
