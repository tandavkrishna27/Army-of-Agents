import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@armyofagents/adapter-utils";
import { buildAoaEnv, ensureAbsoluteDirectory, parseObject, renderTemplate, runChildProcess } from "@armyofagents/adapter-utils/server-utils";
import { DEFAULT_MODEL } from "../index.js";

const PROVIDERS = new Set(["auto", "openrouter", "nous", "openai-codex", "zai", "kimi-coding", "minimax", "minimax-cn"]);
const str = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const num = (value: unknown, fallback: number): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
const strings = (value: unknown): string[] => Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];

const DEFAULT_PROMPT = `You are "{{agentName}}", an AI agent in an AoA company.
Use the terminal tool with curl for AoA API calls. The runtime provides AOA_API_URL, AOA_API_KEY, and AOA_RUN_ID.
Authenticate every API request with -H "Authorization: Bearer $AOA_API_KEY". Include -H "X-AoA-Run-Id: $AOA_RUN_ID" on mutations.
Agent ID: {{agentId}}
Company ID: {{companyId}}
API Base: {{aoaApiUrl}}
{{#taskId}}
Assigned task {{taskId}}: {{taskTitle}}
{{taskBody}}
Work on the task, then mark it done with:
curl -s -X PATCH "$AOA_API_URL/issues/$AOA_TASK_ID" -H "Authorization: Bearer $AOA_API_KEY" -H "X-AoA-Run-Id: $AOA_RUN_ID" -H "Content-Type: application/json" -d '{"status":"done"}'
{{/taskId}}
{{#noTask}}
Check for assigned work with:
curl -s "$AOA_API_URL/companies/{{companyId}}/issues?assigneeAgentId={{agentId}}&status=todo" -H "Authorization: Bearer $AOA_API_KEY"
If assigned work exists, checkout the chosen task with the authenticated API, work on it, then complete it. If nothing is assigned, report briefly.
{{/noTask}}`;

export function buildHermesPrompt(ctx: AdapterExecutionContext, config: Record<string, unknown>, env: Record<string, string>): string {
  const taskId = str(ctx.config.taskId) ?? "";
  const apiUrl = env.AOA_API_URL;
  const hasApiKey = Boolean(str(env.AOA_API_KEY));
  const template = str(config.promptTemplate) ?? DEFAULT_PROMPT;
  let rendered = template.replace(/\{\{#taskId\}\}([\s\S]*?)\{\{\/taskId\}\}/g, taskId ? "$1" : "")
    .replace(/\{\{#noTask\}\}([\s\S]*?)\{\{\/noTask\}\}/g, taskId ? "" : "$1");
  rendered = renderTemplate(rendered, {
    agentId: ctx.agent.id, agentName: ctx.agent.name, companyId: ctx.agent.companyId,
    companyName: str(ctx.config.companyName) ?? "", runId: ctx.runId,
    taskId, taskTitle: str(ctx.config.taskTitle) ?? "", taskBody: str(ctx.config.taskBody) ?? "",
    projectName: str(ctx.config.projectName) ?? "", aoaApiUrl: apiUrl,
  });
  if (!hasApiKey) {
    // Even a custom template must not direct a keyless agent to mutate the API.
    return `AoA API authentication is unavailable for this run. Do not call or mutate the AoA API. Work locally and report your results.\n\n${str(ctx.config.taskBody) ?? ""}`;
  }
  return rendered;
}

export function parseHermesOutput(stdout: string, stderr: string) {
  const combined = `${stdout}\n${stderr}`;
  const sessionId = /^session_id:\s*(\S+)/m.exec(stdout)?.[1] ?? /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i.exec(combined)?.[1];
  const response = sessionId ? stdout.replace(/\n?session_id:\s*\S+\s*$/m, "").trim() : stdout.trim();
  const usageMatch = /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i.exec(combined);
  const costMatch = /(?:cost|spent)[:\s]*\$?([\d.]+)/i.exec(combined);
  const errorLines = stderr.split(/\r?\n/).filter((line) => /error|exception|traceback|failed/i.test(line) && !/INFO|DEBUG|warn/i.test(line));
  return {
    sessionId,
    response,
    usage: usageMatch ? { inputTokens: Number(usageMatch[1]), outputTokens: Number(usageMatch[2]) } : undefined,
    costUsd: costMatch ? Number(costMatch[1]) : undefined,
    errorMessage: errorLines.length ? errorLines.slice(0, 5).join("\n") : undefined,
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = parseObject(ctx.agent.adapterConfig);
  const command = str(config.hermesCommand) ?? str(config.command) ?? "hermes";
  const model = str(config.model) ?? DEFAULT_MODEL;
  const provider = str(config.provider);
  const timeoutSec = num(config.timeoutSec, 300);
  const graceSec = num(config.graceSec, 10);
  const taskId = str(ctx.config.taskId);
  const configuredEnv = parseObject(config.env);
  const env: Record<string, string> = { ...buildAoaEnv(ctx.agent) };
  for (const [key, value] of Object.entries(configuredEnv)) if (typeof value === "string") env[key] = value;
  env.AOA_RUN_ID = ctx.runId;
  if (taskId) env.AOA_TASK_ID = taskId;
  if (!str(env.AOA_API_KEY) && str(ctx.authToken)) env.AOA_API_KEY = ctx.authToken!;
  env.AOA_API_URL = (str(config.aoaApiUrl) ?? str(env.AOA_API_URL) ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
  if (!env.AOA_API_URL.endsWith("/api")) env.AOA_API_URL += "/api";
  const prompt = buildHermesPrompt(ctx, config, env);
  const args = ["chat", "-q", prompt];
  if (config.quiet !== false) args.push("-Q");
  args.push("-m", model);
  if (provider && PROVIDERS.has(provider)) args.push("--provider", provider);
  const toolsets = str(config.toolsets) ?? strings(config.enabledToolsets).join(",");
  if (toolsets) args.push("-t", toolsets);
  if (config.worktreeMode === true) args.push("-w");
  if (config.checkpoints === true) args.push("--checkpoints");
  if (config.verbose === true) args.push("-v");
  const prevSessionId = str(ctx.runtime.sessionParams?.sessionId);
  if (config.persistSession !== false && prevSessionId) args.push("--resume", prevSessionId);
  args.push(...strings(config.extraArgs));
  const cwd = path.resolve(str(config.cwd) ?? str(ctx.config.workspaceDir) ?? process.cwd());
  try {
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
      throw new Error("Hermes batch shims cannot safely receive a task prompt on Windows. Configure hermesCommand to the native hermes.exe executable.");
    }
    await ensureAbsoluteDirectory(cwd);
    await ctx.onLog("stdout", `[hermes] Starting Hermes Agent (model=${model}, timeout=${timeoutSec}s)\n`);
    const result = await runChildProcess(ctx.runId, command, args, { cwd, env, timeoutSec, graceSec, onLog: ctx.onLog, onSpawn: ctx.onSpawn, shell: false });
    const parsed = parseHermesOutput(result.stdout ?? "", result.stderr ?? "");
    const failed = result.timedOut || result.exitCode !== 0 || !parsed.response;
    return {
      exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
      provider: provider ?? null, model, executionCwd: cwd,
      errorMessage: failed ? parsed.errorMessage ?? (result.timedOut ? `Hermes timed out after ${timeoutSec}s` : result.exitCode === 0 ? "Hermes returned no response" : ((result.stderr ?? "").trim() || `Hermes exited with code ${result.exitCode}`)) : undefined,
      ...(parsed.usage ? { usage: parsed.usage } : {}),
      ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
      ...(parsed.response ? { summary: parsed.response.slice(0, 2000) } : {}),
      ...(config.persistSession !== false && parsed.sessionId ? { sessionParams: { sessionId: parsed.sessionId }, sessionDisplayId: parsed.sessionId.slice(0, 16) } : {}),
    };
  } catch (error) {
    return { exitCode: null, signal: null, timedOut: false, provider: provider ?? null, model, executionCwd: cwd,
      errorMessage: error instanceof Error ? error.message : String(error) };
  }
}
