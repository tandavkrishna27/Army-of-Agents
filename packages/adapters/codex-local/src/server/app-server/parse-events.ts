/**
 * W5c Task 4 — the REAL app-server notification accumulator.
 *
 * `createAppServerResultAccumulator()` conforms to the driver's
 * `AppServerAccumulator` interface (Task 3): the driver feeds every notification
 * through `onNotification(method, params)` and reads `result()` once at the end.
 * `result()` returns the neutral intermediate the driver augments with
 * `sessionId`/`timedOut`/`clearSession`.
 *
 * The parser derives `chunks` from the SHARED helpers in `parse-shared.ts` — the
 * SAME code the `codex exec` JSONL path (`parseCodexJsonl`) uses — so the two
 * spawn modes cannot drift. The parity test in `appserver-parse-events.test.ts`
 * feeds the same tool payload through both paths and asserts identical chunks.
 *
 * Field-name/shape parity with `parseCodexJsonl` (exec path, parse.ts):
 * - summary: agent message texts joined with "\n\n" then `.trim()`
 *   (exec: `messages.join("\n\n").trim()`).
 * - usage: `{ inputTokens, cachedInputTokens, outputTokens }`
 *   (exec builds the identical object; app-server maps `tokenUsage.total.*`).
 * - chunks: reasoning / tool_result / action_confirmation via the shared helpers,
 *   preserving the mcp-only `outputRefs` gate (exec: only `mcp_tool_call` lifts refs).
 */
import { asString, asNumber, parseObject } from "@armyofagents/adapter-utils/server-utils";
import type { AppServerAccumulator, NeutralIntermediate } from "./driver.js";
import {
  liftOutputRefs,
  parseActionConfirmation,
  normalizeToolResultText,
  AOA_MCP_SERVER_ID,
  type CodexParsedChunk,
} from "../parse-shared.js";

/** The usage shape `parseCodexJsonl` returns (parse.ts). Mirror it exactly. */
interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function createAppServerResultAccumulator(): AppServerAccumulator {
  // --- summary state ---------------------------------------------------------
  // We accumulate agent-message text per itemId. A message may arrive as a
  // stream of `item/agentMessage/delta` frames AND/OR a completed
  // `item/completed` (agentMessage) with the full `.text`. We dedupe by itemId:
  // the completed text (when present) WINS over the concatenated deltas (it is
  // the authoritative full text), so a delta stream + completed for the SAME
  // message counts ONCE. Order is first-appearance order.
  const messageOrder: string[] = [];
  const deltaText = new Map<string, string>();
  const completedText = new Map<string, string>();

  const noteMessage = (itemId: string): void => {
    if (!messageOrder.includes(itemId)) messageOrder.push(itemId);
  };

  // --- usage state (last-wins) ----------------------------------------------
  let usage: CodexUsage | null = null;

  // --- chunks ----------------------------------------------------------------
  const chunks: CodexParsedChunk[] = [];

  // --- error state -----------------------------------------------------------
  let errorMessage: string | null = null;
  let errorCode: string | null = null;

  // --- output files (raw path hints for output detection) --------------------
  // Collected raw here. The cwd TRUST BOUNDARY is enforced separately at approval
  // time (approval-bridge validatePathInRoot); execute.ts normalizes these to
  // absolute for heartbeat's output detection. Not a security surface here.
  const outputFiles: string[] = [];

  const handleItemCompleted = (params: unknown): void => {
    const p = parseObject(params);
    const item = parseObject(p.item);
    const itemType = asString(item.type, "");

    // item.type vocabulary is PROTOCOL-DRIVEN, not a house style: the app-server
    // emits `agentMessage` (camelCase) but `reasoning`/`tool_result`/
    // `mcp_tool_call`/`fileChange` (snake_case). Do NOT "normalize" the casing —
    // changing tool_result → toolResult here silently breaks the mcp-only gate.
    if (itemType === "agentMessage") {
      const itemId = asString(item.id, "");
      if (itemId) {
        noteMessage(itemId);
        // Completed text is authoritative — even "" (final empty message) wins
        // so we don't leave a stale delta accumulation counting twice.
        completedText.set(itemId, asString(item.text, ""));
      }
      return;
    }

    if (itemType === "reasoning") {
      const text = asString(item.text, "");
      if (text) chunks.push({ type: "reasoning", delta: text });
      return;
    }

    if (itemType === "tool_result" || itemType === "mcp_tool_call") {
      const chunk = parseActionConfirmation(item);
      if (chunk) {
        chunks.push(chunk);
      } else if (itemType === "mcp_tool_call") {
        // Gate: lift outputRefs ONLY from mcp_tool_call items whose server is the
        // AoA MCP server. Plain tool_result items are built-in/shell results and
        // non-`aoa` servers (Playwright etc.) must never produce ref chips — the
        // phantom + cross-MCP-injection defense (Task 4 / Codex P1.1; identical to
        // parseCodexJsonl / parse.ts).
        const text = normalizeToolResultText(item);
        const isAoaServer = asString(item.server, "") === AOA_MCP_SERVER_ID;
        const refs = isAoaServer ? liftOutputRefs(text) : null;
        if (refs) {
          const name = asString(item.name, "") || asString(item.tool, "");
          chunks.push({
            type: "tool_result",
            name,
            result: { success: true, data: text, summary: text },
            refs,
          });
        }
      }
      return;
    }

    if (itemType === "fileChange") {
      // Best-effort raw path hint. The cwd trust boundary is enforced at approval
      // time (approval-bridge); execute.ts normalizes these to absolute.
      const changes = Array.isArray(item.changes) ? item.changes : [];
      for (const change of changes) {
        const rec = parseObject(change);
        const p2 = asString(rec.path, "");
        if (p2 && !outputFiles.includes(p2)) outputFiles.push(p2);
      }
      return;
    }
  };

  return {
    onNotification(method: string, params: unknown): void {
      switch (method) {
        case "item/agentMessage/delta": {
          const p = parseObject(params);
          const itemId = asString(p.itemId, "");
          if (!itemId) return;
          noteMessage(itemId);
          deltaText.set(itemId, (deltaText.get(itemId) ?? "") + asString(p.delta, ""));
          return;
        }

        case "item/completed": {
          handleItemCompleted(params);
          return;
        }

        case "thread/tokenUsage/updated": {
          const p = parseObject(params);
          const tokenUsage = parseObject(p.tokenUsage);
          const total = parseObject(tokenUsage.total);
          // Last-wins snapshot. `cachedInputTokens` is present (camelCase); if the
          // server ever omits it, default to 0 rather than dropping usage entirely.
          usage = {
            inputTokens: asNumber(total.inputTokens, 0),
            cachedInputTokens: asNumber(total.cachedInputTokens, 0),
            outputTokens: asNumber(total.outputTokens, 0),
          };
          return;
        }

        case "error": {
          const p = parseObject(params);
          const msg = asString(p.message, "").trim();
          if (msg) {
            errorMessage = msg;
            const code = asString(p.code, "") || asString(p.type, "");
            if (code) errorCode = code;
          }
          return;
        }

        case "turn/completed": {
          // A completed turn that produced real work may carry a transient
          // (recovered) error frame — clear it. But a turn that completed with
          // ZERO work AND an error present is a masked fatal (e.g. an auth/model
          // 400 that ends the turn with no items): PRESERVE the error so
          // bridgedResultToIntermediate maps it to exitCode:1 instead of a false
          // "succeeded". (M1, hardened for BUG-6.)
          const producedWork =
            messageOrder.length > 0 || chunks.length > 0 || outputFiles.length > 0;
          if (producedWork) {
            errorMessage = null;
            errorCode = null;
          }
          return;
        }

        case "turn/failed": {
          const p = parseObject(params);
          // Live shape: params.turn.error.{message,code}. The driver also
          // synthesizes `{ turn: { error: { message } } }` on turn/start
          // rejection — same nesting. Tolerate a top-level `error` best-effort.
          const turn = parseObject(p.turn);
          const err = parseObject(turn.error ?? p.error);
          const msg = asString(err.message, "").trim();
          if (msg) errorMessage = msg;
          const code = asString(err.code, "") || asString(err.type, "");
          if (code) errorCode = code;
          return;
        }

        default:
          return;
      }
    },

    result(): NeutralIntermediate {
      // Dedupe: completed text wins over deltas for the same itemId (the
      // completed frame carries the authoritative full text). Build in
      // first-appearance order. Mirrors parseCodexJsonl: `messages.join("\n\n").trim()`.
      const messages: string[] = [];
      for (const itemId of messageOrder) {
        const text = completedText.has(itemId)
          ? (completedText.get(itemId) as string)
          : (deltaText.get(itemId) ?? "");
        if (text) messages.push(text);
      }
      return {
        summary: messages.join("\n\n").trim(),
        usage,
        errorMessage,
        errorCode,
        chunks,
        outputFiles,
      };
    },
  };
}
