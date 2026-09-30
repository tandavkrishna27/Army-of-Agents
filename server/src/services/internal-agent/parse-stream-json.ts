/**
 * parse-stream-json.ts
 *
 * Stateful JSONL parser for Claude CLI's `--output-format stream-json` output.
 *
 * The parser ingests raw stdout chunks (which may be partial lines) and emits
 * typed AgentStreamChunk values.  It is the keystone of Phase 4's confirmation
 * flow: the ⚡CONFIRM:…⚡ marker is embedded as literal `tool_result.content`
 * (a string) inside `user` events — before the LLM has any chance to
 * paraphrase it — so the regex match is reliable.
 *
 * Usage:
 *   const parser = new StreamJsonParser();
 *   for (const chunk of parser.push(rawText)) { … }
 *   for (const chunk of parser.flush()) { … }  // call on process exit
 */

import { showRefSchema, MAX_OUTPUT_REFS_PER_MESSAGE, type ShowRef } from "@armyofagents/shared";
import type { AgentStreamChunk } from "./agent-loop.js";
import { redactSecretsInString } from "../../redaction.js";
import { logger } from "../../middleware/logger.js";

/**
 * Trust boundary (Task 4 / Codex P1.1): Commander runs MULTIPLE MCP servers —
 * the AoA server (registered as `aoa` → tool names `mcp__aoa__*`) AND, when
 * browser_use is enabled, a Playwright MCP (`mcp__playwright__*`). Only AoA's
 * server is trusted to emit output-ref envelopes; a non-AoA MCP result carrying
 * a forged `outputRefs` array must never be lifted (it could inject provenance +
 * action:"created" into the Phase-5 auto-open path). Gate lift to this prefix.
 */
const AOA_MCP_TOOL_PREFIX = "mcp__aoa__";

// ── Marker regex ───────────────────────────────────────────────────────────────

/** Non-greedy: stops at the FIRST ⚡ after CONFIRM:, handles nested JSON braces. */
const CONFIRM_RE = /⚡CONFIRM:(.*?)⚡/s;

// ── Parser ─────────────────────────────────────────────────────────────────────

function extractConfirmPayload(text: string): string | null {
  const exactMatch = CONFIRM_RE.exec(text);
  if (exactMatch) return exactMatch[1];

  const markerIndex = text.indexOf("CONFIRM:");
  if (markerIndex < 0) return null;

  const firstBrace = text.indexOf("{", markerIndex + "CONFIRM:".length);
  if (firstBrace < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(firstBrace, i + 1);
    }
  }

  return null;
}

export class StreamJsonParser {
  private buffer: string = "";
  /** tool_use id → tool name, for tool_result name correlation (spinner fix + refs). */
  private toolNames = new Map<string, string>();

  /**
   * Push raw bytes / text from the CLI's stdout.
   * Returns an array of zero or more AgentStreamChunk values derived from any
   * complete lines now available in the buffer.
   */
  push(text: string): AgentStreamChunk[] {
    const lines = (this.buffer + text).split("\n");
    // The last element is the (possibly incomplete) trailing fragment.
    this.buffer = lines.pop() ?? "";
    const chunks: AgentStreamChunk[] = [];
    for (const line of lines) {
      for (const chunk of parseLine(line, this.toolNames)) {
        chunks.push(chunk);
      }
    }
    return chunks;
  }

  /**
   * Flush any remaining buffered content (call on process exit / stream end).
   * Treats whatever is left in the buffer as a complete line.
   */
  flush(): AgentStreamChunk[] {
    if (this.buffer.length === 0) return [];
    const remaining = this.buffer;
    this.buffer = "";
    return parseLine(remaining, this.toolNames);
  }
}

// ── Line-level parser ──────────────────────────────────────────────────────────

function parseLine(line: string, toolNames: Map<string, string>): AgentStreamChunk[] {
  const trimmed = line.trim();

  // Try to parse as a stream-json event first.
  if (trimmed.length > 0) {
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      switch (event.type) {
        case "stream_event":
          return handleStreamEvent(event);
        case "assistant":
          return handleAssistantEvent(event, toolNames);
        case "user":
          return handleUserEvent(event, toolNames);
        case "result":
          return handleResultEvent(event);
        // Informational only — no chunks emitted.
        case "system":
        case "rate_limit_event":
          return [];
        default:
          return [];
      }
    } catch {
      // Not JSON — fall through to the plain-text fallback below.
    }
  }

  // Plain-text fallback: the claude CLI emits the answer for an MCP-tool-using turn as
  // plain text (not stream-json). Re-add the newline that split() stripped so that
  // multi-line markdown reconstructs correctly; a blank line is a paragraph break.
  //
  // This text is raw LLM output and may contain HTML markup injected via prompt attacks.
  //
  // SECURITY INVARIANT: this text reaches the client and is rendered by MarkdownBody.tsx,
  // which uses react-markdown WITHOUT rehype-raw. Without rehype-raw, react-markdown
  // escapes raw HTML rather than injecting it into the DOM, blocking XSS.
  //
  // Do NOT add rehype-raw to MarkdownBody without also adding rehype-sanitize with a
  // strict allowlist — doing so opens an XSS vector through this code path.
  return [{ type: "text", delta: line + "\n" }];
}

// ── stream_event ───────────────────────────────────────────────────────────────

function handleStreamEvent(event: Record<string, unknown>): AgentStreamChunk[] {
  const inner = event.event as Record<string, unknown> | undefined;
  if (!inner) return [];

  // Only content_block_delta carries deltas we need to surface.
  if (inner.type !== "content_block_delta") return [];

  const delta = inner.delta as Record<string, unknown> | undefined;
  if (!delta) return [];

  if (delta.type === "text_delta") {
    const text = delta.text;
    return typeof text === "string" ? [{ type: "text", delta: text }] : [];
  }

  if (delta.type === "thinking_delta") {
    const thinking = delta.thinking;
    return typeof thinking === "string" ? [{ type: "reasoning", delta: thinking }] : [];
  }

  // signature_delta / input_json_delta and any other delta type: not surfaced.
  return [];
}

// ── assistant event ────────────────────────────────────────────────────────────

function handleAssistantEvent(event: Record<string, unknown>, toolNames: Map<string, string>): AgentStreamChunk[] {
  const message = event.message as Record<string, unknown> | undefined;
  if (!message) return [];

  const content = message.content;
  if (!Array.isArray(content)) return [];

  const chunks: AgentStreamChunk[] = [];

  for (const block of content as unknown[]) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;

    if (b.type === "tool_use") {
      // Emit a tool_call chunk using AgentStreamChunk's field names:
      // id (maps from block.id), name, input (maps from block.input)
      const id = typeof b.id === "string" ? b.id : String(b.id ?? "");
      const name = typeof b.name === "string" ? b.name : String(b.name ?? "");
      const input: unknown = b.input ?? {};

      if (id && name) toolNames.set(id, name);
      chunks.push({ type: "tool_call", id, name, input });
    }
    // text + thinking blocks: skip — both stream incrementally via stream_event deltas (text_delta / thinking_delta)
  }

  return chunks;
}

// ── user event ─────────────────────────────────────────────────────────────────

function handleUserEvent(event: Record<string, unknown>, toolNames: Map<string, string>): AgentStreamChunk[] {
  const message = event.message as Record<string, unknown> | undefined;
  if (!message) return [];

  const content = message.content;
  if (!Array.isArray(content)) return [];

  const chunks: AgentStreamChunk[] = [];

  for (const block of content as unknown[]) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;

    if (b.type !== "tool_result") continue;

    // Normalise content to a string (primary: string, defensive: array of text blocks)
    const fullText: string =
      typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content)
          ? (b.content as unknown[])
              .map((c) =>
                typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text"
                  ? String((c as Record<string, unknown>).text ?? "")
                  : "",
              )
              .join("")
          : "";

    // Check for ⚡CONFIRM:…⚡ marker
    const confirmPayload = extractConfirmPayload(fullText);
    if (confirmPayload) {
      try {
        const payload = JSON.parse(confirmPayload) as {
          toolName?: string;
          params?: unknown;
          confirmId?: string;
        };
        if (typeof payload.toolName !== "string" || payload.toolName.length === 0) {
          throw new Error("missing toolName");
        }
        chunks.push({
          type: "action_confirmation",
          toolName: payload.toolName,
          params: payload.params,
          runId: payload.confirmId ?? crypto.randomUUID(),
        });
        continue;
      } catch {
        // Malformed marker JSON — fall through to plain tool_result
      }
    }

    // Plain tool_result: map to AgentStreamChunk's tool_result shape.
    // AgentStreamChunk.tool_result uses { name, result: ToolResult }.
    // We derive:
    //   name   ← resolved from the tool_use id map (spinner fix); falls back to the id
    //   result ← ToolResult { success, data, summary }
    //   refs   ← lifted from the bridge's JSON envelope (Task 4)
    const toolUseId = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
    const resolvedName = toolNames.get(toolUseId) ?? toolUseId;
    const isError = b.is_error === true;

    // Lift outputRefs from the bridge's JSON envelope (lenient — any failure ⇒ no refs).
    // Gated to the AoA MCP server ONLY (mcp__aoa__*): built-in tools (Bash/Read/...)
    // stream raw text that must never be interpreted as an envelope, AND a non-AoA
    // MCP server (Playwright etc.) must never inject refs (Task 4 / Codex P1.1 —
    // cross-MCP injection defense). Also skips JSON.parse on large built-in outputs.
    let refs: ShowRef[] | undefined;
    if (resolvedName.startsWith(AOA_MCP_TOOL_PREFIX)) {
      try {
        const parsedEnvelope = JSON.parse(fullText) as { outputRefs?: unknown };
        const rawRefs = parsedEnvelope?.outputRefs;
        if (Array.isArray(rawRefs) && rawRefs.length > 0) {
          // Per-ref validation (parity with codex liftOutputRefs + the persistence
          // path): validate each ref independently so one malformed sibling does
          // not drop the whole array. Dropped refs are logged (P2.4 observability).
          const kept: ShowRef[] = [];
          for (const raw of rawRefs) {
            const parsedRef = showRefSchema.safeParse(raw);
            if (parsedRef.success) {
              kept.push(parsedRef.data);
            } else {
              const rec = (raw ?? {}) as Record<string, unknown>;
              logger.debug(
                {
                  service: "commander-cli",
                  toolName: resolvedName,
                  droppedKind: typeof rec.kind === "string" ? rec.kind : null,
                  droppedId: typeof rec.id === "string" ? rec.id : null,
                  zodIssues: parsedRef.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
                },
                "Dropped malformed output ref from claude MCP envelope",
              );
            }
          }
          if (kept.length > 0) refs = kept.slice(0, MAX_OUTPUT_REFS_PER_MESSAGE);
        }
      } catch {
        /* not JSON — fine */
      }
    }

    chunks.push({
      type: "tool_result",
      name: resolvedName,
      result: {
        success: !isError,
        data: fullText,
        summary: fullText,
        ...(isError ? { error: fullText } : {}),
      },
      ...(refs ? { refs } : {}),
    });
  }

  return chunks;
}

// ── result event ───────────────────────────────────────────────────────────────

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function handleResultEvent(event: Record<string, unknown>): AgentStreamChunk[] {
  const usageObj =
    typeof event.usage === "object" && event.usage !== null
      ? (event.usage as Record<string, unknown>)
      : {};
  const inputTokens = asNum(usageObj.input_tokens);
  const outputTokens = asNum(usageObj.output_tokens);
  const cachedInputTokens = asNum(usageObj.cache_read_input_tokens);

  // Subscription CLI runs report total_cost_usd:0 — that's correct/intentional.
  // We forward it verbatim; the route falls back to a token-based estimate when 0.
  const costUsd = asNum(event.total_cost_usd);
  const costCents = costUsd > 0 ? Math.round(costUsd * 100) : 0;

  const chunks: AgentStreamChunk[] = [];

  // A `result` event can report subtype:"success" while still carrying an API
  // failure (e.g. auth): claude sets is_error + api_error_status and puts the
  // human-readable reason in `result`. Without this the turn renders as an
  // empty success — no content, no error (the silent-empty-turn bug).
  // `is_error` is the documented signal. `api_error_status` only WIDENS it for
  // the defensive case where the field is absent — it must never override an
  // explicit `is_error: false`, or a turn the CLI retried past and then
  // succeeded would render its real answer text as an error.
  const isError =
    event.is_error === true ||
    (event.is_error !== false && typeof event.api_error_status === "number");
  if (isError) {
    const raw = typeof event.result === "string" ? event.result.trim() : "";
    chunks.push({
      type: "error",
      // Best-effort scrub only — NOT a sanitization boundary. redactSecretsInString
      // matches known secret VALUE shapes (sk-ant-*, gh*_*, JWTs, PEM blocks, DSNs);
      // an opaque/hex bearer token in vendor error text passes through unredacted.
      // Do not treat this call as a guarantee that the message is secret-free.
      message:
        raw.length > 0 ? redactSecretsInString(raw) : "The CLI reported an error but gave no detail.",
    });
  }

  chunks.push({
    type: "done",
    summary: {
      runId: "",
      toolsCalled: [],
      durationMs: asNum(event.duration_ms),
      costCents,
      tokenUsage: { inputTokens, outputTokens, cachedInputTokens },
    },
  });

  return chunks;
}
