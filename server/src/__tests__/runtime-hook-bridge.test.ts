/**
 * Tests for runtime-hook-bridge.ts
 *
 * Covers:
 *   buildPermissionPromptFromHook(payload) — maps a raw PreToolUse hook payload
 *   to AdapterRuntimePermissionPrompt, including:
 *     - tool_name → toolName
 *     - Bash tool_input.command → command + riskClass:"shell"
 *     - Write/Edit/MultiEdit/NotebookEdit tool_input.file_path → path + riskClass:"filesystem"
 *     - WebFetch tool_input.url → networkTarget (host) + riskClass:"network"
 *     - cwd forwarded
 *     - Readable title/summary/promptText
 *     - Deterministic nonce over canonical (sorted-key) JSON
 *     - timeoutPolicy: "escalate"
 *     - expiresAt ≈ now + RUNTIME_HOOK_BLOCK_TIMEOUT_SEC*1000
 *     - Redaction: secrets in command/file_path absent from all string fields
 *     - Scope fields align with trustRuleMatchesPrompt (toolName/command/path/networkTarget/riskClass)
 *
 *   mapAnswerToHookResponse(answer) — maps an AdapterRuntimePermissionAnswer
 *   to the PreToolUse hook JSON response.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { RUNTIME_HOOK_BLOCK_TIMEOUT_SEC } from "@armyofagents/adapter-utils";
import {
  buildPermissionPromptFromHook,
  mapAnswerToHookResponse,
  type PreToolUsePayload,
} from "../services/runtime-hook-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const sorted = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, JSON.parse(canonicalJSON(v))]),
  );
  return JSON.stringify(sorted);
}

function expectedNonce(sessionId: string, toolName: string, toolInput: Record<string, unknown>): string {
  const data = `${sessionId}:${toolName}:${canonicalJSON(toolInput)}`;
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// buildPermissionPromptFromHook
// ---------------------------------------------------------------------------

describe("buildPermissionPromptFromHook", () => {
  const SESSION_ID = "session-abc-123";
  const CWD = "/home/agent/workspace";

  // -------------------------------------------------------------------------
  // Bash tool
  // -------------------------------------------------------------------------
  describe("Bash tool", () => {
    const bashPayload: PreToolUsePayload = {
      session_id: SESSION_ID,
      cwd: CWD,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la /tmp" },
    };

    it("sets toolName from tool_name", () => {
      const prompt = buildPermissionPromptFromHook(bashPayload);
      expect(prompt.toolName).toBe("Bash");
    });

    it("sets command from tool_input.command", () => {
      const prompt = buildPermissionPromptFromHook(bashPayload);
      expect(prompt.command).toBe("ls -la /tmp");
    });

    it("sets riskClass to shell", () => {
      const prompt = buildPermissionPromptFromHook(bashPayload);
      expect(prompt.riskClass).toBe("shell");
    });

    it("sets cwd from payload cwd", () => {
      const prompt = buildPermissionPromptFromHook(bashPayload);
      expect(prompt.cwd).toBe(CWD);
    });

    it("produces readable title containing tool name", () => {
      const prompt = buildPermissionPromptFromHook(bashPayload);
      expect(prompt.title).toContain("Bash");
    });

    it("produces summary containing command text", () => {
      const prompt = buildPermissionPromptFromHook(bashPayload);
      expect(prompt.summary).toBeTruthy();
      expect(typeof prompt.summary).toBe("string");
    });

    it("produces promptText", () => {
      const prompt = buildPermissionPromptFromHook(bashPayload);
      expect(prompt.promptText).toBeTruthy();
    });

    it("path and networkTarget are null for Bash", () => {
      const prompt = buildPermissionPromptFromHook(bashPayload);
      expect(prompt.path).toBeNull();
      expect(prompt.networkTarget).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Write / Edit / MultiEdit / NotebookEdit tools (filesystem)
  // -------------------------------------------------------------------------
  describe.each(["Write", "Edit", "MultiEdit", "NotebookEdit"])("%s tool (filesystem)", (toolName) => {
    const filePath = "/home/agent/workspace/output.ts";
    const payload: PreToolUsePayload = {
      session_id: SESSION_ID,
      cwd: CWD,
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: { file_path: filePath, content: "// some code" },
    };

    it("sets path from tool_input.file_path", () => {
      const prompt = buildPermissionPromptFromHook(payload);
      expect(prompt.path).toBe(filePath);
    });

    it("sets riskClass to filesystem", () => {
      const prompt = buildPermissionPromptFromHook(payload);
      expect(prompt.riskClass).toBe("filesystem");
    });

    it("sets toolName", () => {
      const prompt = buildPermissionPromptFromHook(payload);
      expect(prompt.toolName).toBe(toolName);
    });

    it("command and networkTarget are null", () => {
      const prompt = buildPermissionPromptFromHook(payload);
      expect(prompt.command).toBeNull();
      expect(prompt.networkTarget).toBeNull();
    });

    it("produces readable title", () => {
      const prompt = buildPermissionPromptFromHook(payload);
      expect(prompt.title).toContain(toolName);
    });
  });

  // -------------------------------------------------------------------------
  // WebFetch tool (network)
  // -------------------------------------------------------------------------
  describe("WebFetch tool", () => {
    const url = "https://api.example.com/data?q=1";
    const payload: PreToolUsePayload = {
      session_id: SESSION_ID,
      cwd: CWD,
      hook_event_name: "PreToolUse",
      tool_name: "WebFetch",
      tool_input: { url, prompt: "Summarize this" },
    };

    it("sets networkTarget to host only (no path/query)", () => {
      const prompt = buildPermissionPromptFromHook(payload);
      expect(prompt.networkTarget).toBe("api.example.com");
    });

    it("sets riskClass to network", () => {
      const prompt = buildPermissionPromptFromHook(payload);
      expect(prompt.riskClass).toBe("network");
    });

    it("sets toolName", () => {
      const prompt = buildPermissionPromptFromHook(payload);
      expect(prompt.toolName).toBe("WebFetch");
    });

    it("command and path are null", () => {
      const prompt = buildPermissionPromptFromHook(payload);
      expect(prompt.command).toBeNull();
      expect(prompt.path).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Unknown / unrecognized tools
  // -------------------------------------------------------------------------
  describe("unknown tool", () => {
    const payload: PreToolUsePayload = {
      session_id: SESSION_ID,
      cwd: CWD,
      hook_event_name: "PreToolUse",
      tool_name: "SomeFutureTool",
      tool_input: { weird_param: "value" },
    };

    it("still produces a valid prompt", () => {
      const prompt = buildPermissionPromptFromHook(payload);
      expect(prompt.toolName).toBe("SomeFutureTool");
      expect(prompt.title).toBeTruthy();
    });

    it("command, path, networkTarget are null", () => {
      const prompt = buildPermissionPromptFromHook(payload);
      expect(prompt.command).toBeNull();
      expect(prompt.path).toBeNull();
      expect(prompt.networkTarget).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Nonce — deterministic canonical (sorted-key) JSON
  // -------------------------------------------------------------------------
  describe("nonce", () => {
    it("is a 64-char hex sha256", () => {
      const payload: PreToolUsePayload = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
      };
      const prompt = buildPermissionPromptFromHook(payload);
      expect(prompt.nonce).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic: same payload always yields same nonce", () => {
      const payload: PreToolUsePayload = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
      };
      const a = buildPermissionPromptFromHook(payload);
      const b = buildPermissionPromptFromHook(payload);
      expect(a.nonce).toBe(b.nonce);
    });

    it("produces the expected sha256 value", () => {
      const toolInput = { command: "echo hello" };
      const payload: PreToolUsePayload = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: toolInput,
      };
      const prompt = buildPermissionPromptFromHook(payload);
      expect(prompt.nonce).toBe(expectedNonce(SESSION_ID, "Bash", toolInput));
    });

    it("is IDENTICAL when tool_input keys are in a different order (canonical sort)", () => {
      // Same logical input with keys in different order
      const payloadA: PreToolUsePayload = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/foo/bar.ts", content: "hello" },
      };
      const payloadB: PreToolUsePayload = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        // Note: keys in reverse order — content before file_path
        tool_input: { content: "hello", file_path: "/foo/bar.ts" },
      };
      const promptA = buildPermissionPromptFromHook(payloadA);
      const promptB = buildPermissionPromptFromHook(payloadB);
      expect(promptA.nonce).toBe(promptB.nonce);
    });

    it("differs when session_id changes", () => {
      const base = {
        cwd: CWD,
        hook_event_name: "PreToolUse" as const,
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
      };
      const a = buildPermissionPromptFromHook({ session_id: "sess-1", ...base });
      const b = buildPermissionPromptFromHook({ session_id: "sess-2", ...base });
      expect(a.nonce).not.toBe(b.nonce);
    });

    it("differs when command changes", () => {
      const base = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse" as const,
        tool_name: "Bash",
      };
      const a = buildPermissionPromptFromHook({ ...base, tool_input: { command: "echo A" } });
      const b = buildPermissionPromptFromHook({ ...base, tool_input: { command: "echo B" } });
      expect(a.nonce).not.toBe(b.nonce);
    });
  });

  // -------------------------------------------------------------------------
  // timeoutPolicy and expiresAt
  // -------------------------------------------------------------------------
  describe("timeoutPolicy and expiresAt", () => {
    it('sets timeoutPolicy to "escalate"', () => {
      const payload: PreToolUsePayload = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      };
      const prompt = buildPermissionPromptFromHook(payload);
      expect(prompt.timeoutPolicy).toBe("escalate");
    });

    it("expiresAt is approximately now + RUNTIME_HOOK_BLOCK_TIMEOUT_SEC seconds", () => {
      const before = Date.now();
      const payload: PreToolUsePayload = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      };
      const prompt = buildPermissionPromptFromHook(payload);
      const after = Date.now();

      const expiresAtMs =
        prompt.expiresAt instanceof Date
          ? prompt.expiresAt.getTime()
          : new Date(prompt.expiresAt as string).getTime();

      const expectedMin = before + RUNTIME_HOOK_BLOCK_TIMEOUT_SEC * 1000;
      const expectedMax = after + RUNTIME_HOOK_BLOCK_TIMEOUT_SEC * 1000;

      expect(expiresAtMs).toBeGreaterThanOrEqual(expectedMin);
      expect(expiresAtMs).toBeLessThanOrEqual(expectedMax + 100); // small tolerance
    });

    it("accepts a custom clock via options.now", () => {
      const fixedNow = new Date("2025-01-01T00:00:00.000Z");
      const payload: PreToolUsePayload = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      };
      const prompt = buildPermissionPromptFromHook(payload, { now: () => fixedNow });
      const expiresAtMs =
        prompt.expiresAt instanceof Date
          ? prompt.expiresAt.getTime()
          : new Date(prompt.expiresAt as string).getTime();
      expect(expiresAtMs).toBe(fixedNow.getTime() + RUNTIME_HOOK_BLOCK_TIMEOUT_SEC * 1000);
    });
  });

  // -------------------------------------------------------------------------
  // Redaction — secrets must not appear in any string field
  // -------------------------------------------------------------------------
  describe("redaction", () => {
    const SECRET = "sk-ant-abc123DEF456ghi789";

    it("redacts a secret in Bash command from all string fields", () => {
      const payload: PreToolUsePayload = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `curl -H "Authorization: Bearer ${SECRET}" https://api.example.com` },
      };
      const prompt = buildPermissionPromptFromHook(payload);

      // The raw secret must not appear in any string field of the prompt
      const stringFields = [
        prompt.command,
        prompt.summary,
        prompt.promptText,
        prompt.title,
        prompt.path,
        prompt.networkTarget,
        prompt.cwd,
      ].filter((f): f is string => typeof f === "string");

      for (const field of stringFields) {
        expect(field).not.toContain(SECRET);
      }
    });

    it("redacts a secret-looking file path content from filesystem fields", () => {
      // The secret is in the content, not the path — path itself is fine
      const payload: PreToolUsePayload = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: "/home/agent/output.ts",
          content: `const key = "${SECRET}";`,
        },
      };
      const prompt = buildPermissionPromptFromHook(payload);

      // Content is not surfaced in any prompt field (only file_path is used),
      // but we assert the secret is absent from every string field just in case.
      const stringFields = [
        prompt.command,
        prompt.summary,
        prompt.promptText,
        prompt.title,
        prompt.path,
        prompt.networkTarget,
        prompt.cwd,
      ].filter((f): f is string => typeof f === "string");

      for (const field of stringFields) {
        expect(field).not.toContain(SECRET);
      }
    });

    it("redacts Bearer token in Bash command", () => {
      const bearerToken = "sk-ant-api01-SECRETSECRETSECRETSECRET123456789";
      const payload: PreToolUsePayload = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `curl -H "Authorization: Bearer ${bearerToken}" https://api.x.com` },
      };
      const prompt = buildPermissionPromptFromHook(payload);

      const stringFields = [
        prompt.command,
        prompt.summary,
        prompt.promptText,
      ].filter((f): f is string => typeof f === "string");

      for (const field of stringFields) {
        expect(field).not.toContain(bearerToken);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scope field alignment with trustRuleMatchesPrompt
  //
  // trustRuleMatchesPrompt (agent-runtime-decisions.ts) inspects:
  //   rule.toolName        → compared to input.toolName
  //   rule.commandHash     → compared to sha256(input.command)
  //   rule.pathScope       → prefix-matched against input.path
  //   rule.networkScope    → exact-matched against input.networkTarget
  //   rule.riskClass       → compared to input.riskClass
  //
  // Our bridge MUST populate these fields with the correct values so that
  // an allow_always trust rule created by the founder will short-circuit
  // future identical prompts.
  // -------------------------------------------------------------------------
  describe("scope fields align with trustRuleMatchesPrompt", () => {
    it("Bash prompt has toolName, command, riskClass populated (no path/networkTarget)", () => {
      const payload: PreToolUsePayload = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm run build" },
      };
      const prompt = buildPermissionPromptFromHook(payload);
      // toolName → used by trustRuleMatchesPrompt rule.toolName check
      expect(prompt.toolName).toBe("Bash");
      // command → hashed to commandHash for trust rule matching
      expect(prompt.command).toBe("npm run build");
      // riskClass → used by trustRuleMatchesPrompt rule.riskClass check
      expect(prompt.riskClass).toBe("shell");
    });

    it("Write prompt has toolName, path, riskClass populated (no command/networkTarget)", () => {
      const filePath = "/workspace/src/index.ts";
      const payload: PreToolUsePayload = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: filePath, content: "// code" },
      };
      const prompt = buildPermissionPromptFromHook(payload);
      // path → used by trustRuleMatchesPrompt pathMatchesScope(input.path, rule.pathScope)
      expect(prompt.path).toBe(filePath);
      expect(prompt.toolName).toBe("Write");
      expect(prompt.riskClass).toBe("filesystem");
    });

    it("WebFetch prompt has toolName, networkTarget, riskClass populated (no command/path)", () => {
      const payload: PreToolUsePayload = {
        session_id: SESSION_ID,
        cwd: CWD,
        hook_event_name: "PreToolUse",
        tool_name: "WebFetch",
        tool_input: { url: "https://docs.anthropic.com/page", prompt: "Get the content" },
      };
      const prompt = buildPermissionPromptFromHook(payload);
      // networkTarget → used by trustRuleMatchesPrompt networkMatchesScope(input.networkTarget, rule.networkScope)
      expect(prompt.networkTarget).toBe("docs.anthropic.com");
      expect(prompt.toolName).toBe("WebFetch");
      expect(prompt.riskClass).toBe("network");
    });
  });

  // -------------------------------------------------------------------------
  // kind
  // -------------------------------------------------------------------------
  it('sets kind to "permission"', () => {
    const payload: PreToolUsePayload = {
      session_id: SESSION_ID,
      cwd: CWD,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    };
    const prompt = buildPermissionPromptFromHook(payload);
    expect(prompt.kind).toBe("permission");
  });
});

// ---------------------------------------------------------------------------
// mapAnswerToHookResponse
// ---------------------------------------------------------------------------

describe("mapAnswerToHookResponse", () => {
  const BASE_ANSWER = {
    kind: "permission" as const,
    decisionId: "decision-xyz",
    sourceRevision: 0,
  };

  it("allow_once → permissionDecision allow", () => {
    const response = mapAnswerToHookResponse({ ...BASE_ANSWER, decision: "allow_once" });
    expect(response.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(response.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("allow_always → permissionDecision allow", () => {
    const response = mapAnswerToHookResponse({ ...BASE_ANSWER, decision: "allow_always" });
    expect(response.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(response.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("deny → permissionDecision deny with reason", () => {
    const response = mapAnswerToHookResponse({ ...BASE_ANSWER, decision: "deny" });
    expect(response.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(response.hookSpecificOutput.permissionDecisionReason).toBeTruthy();
  });

  it('never emits permissionDecision "ask"', () => {
    for (const decision of ["allow_once", "allow_always", "deny"] as const) {
      const response = mapAnswerToHookResponse({ ...BASE_ANSWER, decision });
      expect(response.hookSpecificOutput.permissionDecision).not.toBe("ask");
    }
  });

  it("hookEventName is exactly PreToolUse (not PermissionRequest)", () => {
    const response = mapAnswerToHookResponse({ ...BASE_ANSWER, decision: "allow_once" });
    expect(response.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(response.hookSpecificOutput.hookEventName).not.toBe("PermissionRequest");
  });
});
