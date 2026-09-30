/**
 * runtime-hook-bridge.ts
 *
 * Pure functions (no DB, no drizzle) that map between the raw PreToolUse
 * hook payload Claude Code emits and the AdapterRuntimePermissionPrompt shape
 * the decision broker expects.
 *
 * Task 3 of W5b: hook-payload ↔ broker mapping + redaction.
 *
 * Scope field alignment note
 * --------------------------
 * trustRuleMatchesPrompt (agent-runtime-decisions.ts) inspects these fields
 * from CreatePromptInput when an allow_always trust rule is evaluated:
 *   rule.toolName     → compared to input.toolName
 *   rule.commandHash  → compared to sha256(input.command)
 *   rule.pathScope    → prefix-matched against input.path
 *   rule.networkScope → exact-matched against input.networkTarget
 *   rule.riskClass    → compared to input.riskClass
 *
 * We MUST populate toolName / command / path / networkTarget / riskClass
 * correctly so that an allow_always trust rule created by the founder will
 * short-circuit identical future prompts without re-asking.
 */

import { createHash } from "node:crypto";
import type {
  AdapterRuntimePermissionPrompt,
  AdapterRuntimePermissionAnswer,
} from "@armyofagents/adapter-utils";
import { RUNTIME_HOOK_BLOCK_TIMEOUT_SEC } from "@armyofagents/adapter-utils";
import { redactSecretsInString } from "../redaction.js";

// ---------------------------------------------------------------------------
// Payload shape (from the spike: what Claude Code actually POSTs)
// ---------------------------------------------------------------------------

export interface PreToolUsePayload {
  session_id: string;
  cwd: string;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Hook response shape (what we POST back to the adapter's HTTP server)
// ---------------------------------------------------------------------------

export interface HookPermissionResponse {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason?: string;
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BuildPermissionPromptOptions {
  /** Inject a clock for deterministic testing. Defaults to () => new Date(). */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Tool → riskClass lookup
// ---------------------------------------------------------------------------

const FILESYSTEM_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);

type RiskClass = "shell" | "filesystem" | "network" | "unknown";

function resolveRiskClass(toolName: string): RiskClass {
  if (toolName === "Bash") return "shell";
  if (FILESYSTEM_TOOLS.has(toolName)) return "filesystem";
  if (NETWORK_TOOLS.has(toolName)) return "network";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Canonical JSON (sorted keys, recursively) for deterministic nonce
// ---------------------------------------------------------------------------

function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  const sorted = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, JSON.parse(canonicalJSON(v))]),
  );
  return JSON.stringify(sorted);
}

function buildNonce(sessionId: string, toolName: string, toolInput: Record<string, unknown>): string {
  const data = `${sessionId}:${toolName}:${canonicalJSON(toolInput)}`;
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// String truncation helper for titles / summaries
// ---------------------------------------------------------------------------

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…`;
}

function safeStr(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}

// ---------------------------------------------------------------------------
// Extract scope fields per tool type
// ---------------------------------------------------------------------------

interface ToolScope {
  command: string | null;
  path: string | null;
  networkTarget: string | null;
  riskClass: RiskClass;
}

function extractScope(toolName: string, toolInput: Record<string, unknown>): ToolScope {
  const riskClass = resolveRiskClass(toolName);

  if (toolName === "Bash") {
    const raw = safeStr(toolInput.command);
    return {
      command: raw ? redactSecretsInString(raw) : null,
      path: null,
      networkTarget: null,
      riskClass,
    };
  }

  if (FILESYSTEM_TOOLS.has(toolName)) {
    const filePath = safeStr(toolInput.file_path);
    return {
      command: null,
      path: filePath ?? null,
      networkTarget: null,
      riskClass,
    };
  }

  if (NETWORK_TOOLS.has(toolName)) {
    const url = safeStr(toolInput.url);
    let host: string | null = null;
    if (url) {
      try {
        host = new URL(url).hostname;
      } catch {
        host = url;
      }
    }
    return {
      command: null,
      path: null,
      networkTarget: host,
      riskClass,
    };
  }

  // Unknown tool — no scope fields, but we still surface a prompt
  return {
    command: null,
    path: null,
    networkTarget: null,
    riskClass,
  };
}

// ---------------------------------------------------------------------------
// Build human-readable text fields
// ---------------------------------------------------------------------------

function buildTexts(
  toolName: string,
  scope: ToolScope,
): { title: string; summary: string; promptText: string } {
  let detail = "";
  if (scope.command != null) {
    detail = truncate(scope.command, 120);
  } else if (scope.path != null) {
    detail = scope.path;
  } else if (scope.networkTarget != null) {
    detail = scope.networkTarget;
  }

  const title = detail ? `${toolName}: ${truncate(detail, 80)}` : `${toolName} permission request`;
  const summary = `Agent wants to run ${toolName}${detail ? `: ${truncate(detail, 200)}` : ""}`;
  const promptText = detail
    ? `Allow ${toolName} to run?\n\n${detail}`
    : `Allow ${toolName} to run?`;

  return { title, summary, promptText };
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Map a raw PreToolUse hook payload to an AdapterRuntimePermissionPrompt.
 *
 * Pure — no I/O, no DB. Safe to call in tests without any ORM setup.
 *
 * The returned prompt is ready to be passed to
 * agentRuntimeDecisionService.createPrompt() after the caller augments it with
 * companyId / agentId / runId / adapterType.
 */
export function buildPermissionPromptFromHook(
  payload: PreToolUsePayload,
  opts: BuildPermissionPromptOptions = {},
): AdapterRuntimePermissionPrompt & {
  // Ensure the required fields are non-optional for callers who need them
  toolName: string;
  nonce: string;
  expiresAt: Date;
} {
  const now = (opts.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + RUNTIME_HOOK_BLOCK_TIMEOUT_SEC * 1000);

  const scope = extractScope(payload.tool_name, payload.tool_input);
  const { title, summary, promptText } = buildTexts(payload.tool_name, scope);

  const nonce = buildNonce(payload.session_id, payload.tool_name, payload.tool_input);

  return {
    kind: "permission",
    nonce,
    title,
    summary,
    promptText,
    toolName: payload.tool_name,
    command: scope.command,
    cwd: payload.cwd ?? null,
    path: scope.path,
    networkTarget: scope.networkTarget,
    riskClass: scope.riskClass === "unknown" ? null : scope.riskClass,
    options: null,
    expiresAt,
    timeoutPolicy: "escalate",
  };
}

// ---------------------------------------------------------------------------
// Map an answer back to the hook HTTP response shape
// ---------------------------------------------------------------------------

/**
 * Map an AdapterRuntimePermissionAnswer (from the decision broker) to the
 * JSON body the PreToolUse HTTP hook endpoint must return to the claude-local
 * adapter.
 *
 * - allow_once / allow_always → permissionDecision: "allow"
 * - deny                      → permissionDecision: "deny" + reason
 * - Never emits permissionDecision: "ask"
 */
export function mapAnswerToHookResponse(answer: AdapterRuntimePermissionAnswer): HookPermissionResponse {
  if (answer.decision === "deny") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Denied by founder",
      },
    };
  }

  // allow_once or allow_always → allow
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
}
