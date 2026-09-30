import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@armyofagents/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  describeAdapterExecutionTarget,
  readAdapterExecutionTarget,
} from "@armyofagents/adapter-utils/execution-target";
import { asString, parseObject } from "@armyofagents/adapter-utils/server-utils";

type CursorSdkForDiagnostics = {
  Cursor: {
    me(input: { apiKey: string }): Promise<{ userEmail?: string | null; apiKeyName?: string | null }>;
    models: {
      list(input: { apiKey: string }): Promise<Array<{ id: string }>>;
    };
  };
};

async function loadCursorSdkForDiagnostics(): Promise<CursorSdkForDiagnostics | null> {
  try {
    return await import("@cursor/sdk") as CursorSdkForDiagnostics;
  } catch {
    return null;
  }
}

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function asStringEnvMap(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") {
      env[key] = entry;
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      if (rec.type === "plain" && typeof rec.value === "string") env[key] = rec.value;
    }
  }
  return env;
}

function looksLikeRepoUrl(value: string): boolean {
  return /^(https?:\/\/|git@)/i.test(value.trim());
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
  });
  if (adapterExecutionTargetIsRemote(executionTarget)) {
    checks.push({
      code: "cursor_cloud_external_execution_target_unsupported",
      level: "error",
      message: `cursor_cloud cannot execute inside ${describeAdapterExecutionTarget(executionTarget)}.`,
      detail: "Cursor Cloud execution is controlled by runtimeEnvType/runtimeEnvName and runs in Cursor's managed cloud.",
      hint: "Use Cursor Cloud runtime fields for this adapter, or choose a local CLI adapter for AoA sandbox execution.",
    });
  }
  const config = parseObject(ctx.config);
  const env = asStringEnvMap(config.env);
  const apiKey = asString(env.CURSOR_API_KEY, "").trim();
  const repoUrl = asString(config.repoUrl, "").trim();
  const model = asString(config.model, "").trim();

  if (!apiKey) {
    checks.push({
      code: "cursor_cloud_api_key_missing",
      level: "error",
      message: "CURSOR_API_KEY is required.",
      hint: "Add CURSOR_API_KEY under environment variables for this adapter.",
    });
  }

  if (!repoUrl) {
    checks.push({
      code: "cursor_cloud_repo_missing",
      level: "error",
      message: "repoUrl is required.",
      hint: "Set the repository URL Cursor should open for this agent.",
    });
  } else if (!looksLikeRepoUrl(repoUrl)) {
    checks.push({
      code: "cursor_cloud_repo_invalid",
      level: "error",
      message: "repoUrl must be an http(s) or git SSH repository URL.",
      detail: repoUrl,
    });
  } else {
    checks.push({
      code: "cursor_cloud_repo_present",
      level: "info",
      message: `Repository configured: ${repoUrl}`,
    });
  }

  const cursorSdk = apiKey ? await loadCursorSdkForDiagnostics() : null;
  if (apiKey && !cursorSdk) {
    checks.push({
      code: "cursor_cloud_sdk_unavailable",
      level: "error",
      message: "Cursor SDK is unavailable in this environment.",
      hint: "Install the Cursor SDK native dependencies or use a Cursor Cloud integration path that does not require sqlite3.",
    });
  }

  if (apiKey && cursorSdk) {
    try {
      const me = await cursorSdk.Cursor.me({ apiKey });
      checks.push({
        code: "cursor_cloud_auth_ok",
        level: "info",
        message: "Cursor API key is valid.",
        detail: me.userEmail ? `Authenticated as ${me.userEmail}.` : `API key: ${me.apiKeyName}`,
      });
    } catch (err) {
      checks.push({
        code: "cursor_cloud_auth_failed",
        level: "error",
        message: err instanceof Error ? err.message : "Failed to validate Cursor API key.",
      });
    }
  }

  if (apiKey && model && cursorSdk) {
    try {
      const models = await cursorSdk.Cursor.models.list({ apiKey });
      const match = models.find((entry) => entry.id === model);
      checks.push({
        code: match ? "cursor_cloud_model_ok" : "cursor_cloud_model_unknown",
        level: match ? "info" : "warn",
        message: match
          ? `Model "${model}" is available to the authenticated Cursor account.`
          : `Model "${model}" was not found in the authenticated Cursor model list.`,
      });
    } catch (err) {
      checks.push({
        code: "cursor_cloud_model_probe_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "Failed to validate model availability.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
