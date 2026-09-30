import { detectAuthFailure, isLoopbackUrl, type AuthFailureKind, type UsageSummary } from "@armyofagents/adapter-utils";
import { asString, asNumber, parseObject, parseJson } from "@armyofagents/adapter-utils/server-utils";

const URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;

export function parseClaudeStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    if (type === "assistant") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      const message = parseObject(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block.type, "") === "text") {
          const text = asString(block.text, "");
          if (text) assistantTexts.push(text);
        }
      }
      continue;
    }

    if (type === "result") {
      finalResult = isClaudeMaxTurnsResult(event)
        ? { ...event, stopReason: "max_turns_exhausted" }
        : event;
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
    };
  }

  const usageObj = parseObject(finalResult.usage);
  const usage: UsageSummary = {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
  };
  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

  return {
    sessionId,
    model,
    costUsd,
    usage,
    summary,
    resultJson: finalResult,
  };
}

function extractClaudeErrorMessages(parsed: Record<string, unknown>): string[] {
  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  const messages: string[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }

    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function extractClaudeLoginUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("claude") || cleaned.includes("anthropic") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

/**
 * `claude --output-format stream-json`'s terminal `result` event carries a
 * structured `api_error_status` (the HTTP status of the failed API call)
 * alongside `is_error`. Field evidence: a revoked-token run returns
 * `{"subtype":"success","is_error":true,"api_error_status":401,...}` — note
 * `subtype` is misleadingly "success" even on failure, so `api_error_status`
 * (a number) is a more reliable auth signal than pattern-matching `result`
 * text, which can drift across CLI versions. `parsed` is untyped JSON, so
 * every field access here is guarded.
 */
function apiErrorStatusIndicatesAuthFailure(parsed: Record<string, unknown> | null): boolean {
  if (!parsed) return false;
  const status = parsed.api_error_status;
  return typeof status === "number" && (status === 401 || status === 403);
}

export function detectClaudeLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
  /**
   * Exit code of the process that produced stdout/stderr, when the caller
   * has it. `stdout` is transcript-bearing for stream-json (it carries the
   * agent's whole turn, not just error output), so it is only safe to feed
   * into the auth classifier when the process actually failed — otherwise
   * agent prose that merely *discusses* auth ("Added a handler returning 401
   * for missing sessions") would misclassify a successful run as needing
   * login.
   *
   * - `exitCode` is a number and `!== 0` (real failure): stdout included.
   * - `exitCode === 0` (real success): stdout excluded.
   * - `exitCode` is `undefined`/`null` (caller doesn't know): stdout is
   *   still included, to preserve pre-existing detection for call sites that
   *   haven't been updated to pass it. Only known-successful runs are
   *   exempted.
   */
  exitCode?: number | null;
}): { requiresLogin: boolean; loginUrl: string | null; kind: AuthFailureKind } {
  const processKnownSuccessful = typeof input.exitCode === "number" && input.exitCode === 0;
  // `parsed.result` (resultText) is deliberately EXCLUDED: it is the agent's
  // final authored answer, never process failure output, and must never
  // feed the auth classifier (see auth-failure-detector.ts's input contract).
  const haystack = [
    ...extractClaudeErrorMessages(input.parsed ?? {}),
    input.stderr,
    ...(processKnownSuccessful ? [] : [input.stdout]),
  ].join("\n");

  // Shared detector: the old local regex matched only never-signed-in phrasing
  // and missed every revoked/expired/401 failure. Its loginUrl is also more
  // reliable than extractClaudeLoginUrl's fallback below: it's gated to
  // auth-shaped URLs (never "first URL of any kind") and skips loopback
  // callback hosts.
  const { kind: textKind, loginUrl: detectedLoginUrl } = detectAuthFailure(haystack);

  // Structured signal wins over the text detector: `api_error_status` is a
  // number the CLI reports directly, not a pattern match against prose that
  // could drift. A structured 401/403 means credentials were presented and
  // rejected — that is the "expired" shape, not "signed_out" (no
  // credentials) or "invalid_key" (a key was supplied and is malformed).
  //
  // Gated on `!processKnownSuccessful`, same as the haystack above: an exit-0
  // run can carry a stale/leftover `api_error_status` from an earlier turn,
  // and trusting it unconditionally would reopen the exact false-positive
  // class the exitCode gate above exists to close (misclassifying a
  // successful run AND spawning the status probe on the happy path).
  const kind: AuthFailureKind =
    !processKnownSuccessful && apiErrorStatusIndicatesAuthFailure(input.parsed) ? "expired" : textKind;

  // Fallback only: extractClaudeLoginUrl's "first URL of any kind" behavior
  // can surface a bogus link when the shared detector found none. Still
  // reject a loopback callback host even from the fallback — see the shared
  // `isLoopbackUrl` (adapter-utils/login-url-detector.ts).
  const fallbackLoginUrl = extractClaudeLoginUrl([input.stdout, input.stderr].join("\n"));
  const loginUrl =
    detectedLoginUrl ?? (fallbackLoginUrl && !isLoopbackUrl(fallbackLoginUrl) ? fallbackLoginUrl : null);

  return {
    requiresLogin: kind !== "none",
    loginUrl,
    kind,
  };
}

export function describeClaudeFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errors = extractClaudeErrorMessages(parsed);

  let detail = resultText;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Claude run failed"];
  if (subtype) parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function isClaudeMaxTurnsResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "error_max_turns") return true;

  const stopReason = asString(parsed.stop_reason, "").trim().toLowerCase();
  if (stopReason === "max_turns") return true;

  const resultText = asString(parsed.result, "").trim();
  return /max(?:imum)?\s+turns?/i.test(resultText);
}

export function isClaudeUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /no conversation found with session id|unknown session|session .* not found/i.test(msg),
  );
}
