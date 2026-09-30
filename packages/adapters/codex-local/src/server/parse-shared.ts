import { randomUUID } from "node:crypto";
import { asString, parseObject } from "@armyofagents/adapter-utils/server-utils";

/**
 * Shared chunk-derivation helpers for the codex_local parser.
 *
 * Extracted verbatim from `parse.ts` so BOTH the `codex exec` JSONL path
 * (`parseCodexJsonl` in parse.ts) and the `codex app-server` notification path
 * (`parse-events.ts`) derive their `chunks` from ONE copy of the code and cannot
 * drift. This is a pure move+export — the logic is unchanged. See the
 * accumulator parity test (`appserver-parse-events.test.ts`) which feeds the same
 * tool payload through both paths and asserts identical chunks.
 */

const CONFIRM_RE = /⚡CONFIRM:(.*?)⚡/s;

/**
 * Trust boundary (Task 4 / Codex P1.1): the AoA MCP server is registered under
 * the config key `aoa` (see server/src/services/internal-agent/cli-mode.ts
 * buildMcpConfig → `mcpServers: { aoa }`; Playwright is `playwright`). codex
 * reports that config-key as the tool call's `server`. Only refs from THIS
 * server are trusted — a non-`aoa` MCP result carrying an `outputRefs` envelope
 * must never be lifted (cross-MCP forged-ref / auto-open injection defense).
 */
export const AOA_MCP_SERVER_ID = "aoa";

/**
 * Structural mirror of @armyofagents/shared ShowRef — v1
 * (CommanderOutputRef, artifact-only) plus v2 (the 8-kind set + provenance).
 * This package deliberately has no dependency on shared; the screen below
 * enforces the shape and the server zod-validates again at persist time.
 */
const LIFTED_SHOW_REF_KINDS = [
  "artifact", "asset", "output", "task", "discussion", "approval", "memory_item", "url",
] as const;
type LiftedShowRefKind = (typeof LIFTED_SHOW_REF_KINDS)[number];

type LiftedProvenance = {
  agentId?: string | null;
  surface: "commander" | "discussion" | "workspace";
  entityId: string;
  runId?: string | null;
  messageId?: string | null;
  seq: number;
  emittedAt: string;
};

export type LiftedOutputRef = {
  v: 1 | 2;
  kind: LiftedShowRefKind;
  id: string;
  versionId?: string | null;
  versionNumber?: number | null;
  title?: string | null;
  action: "created" | "referenced";
  toolCallId?: string | null;
  mimeType?: string | null;
  viewerKind?: string | null; // v2 only
  provenance?: LiftedProvenance | null; // v2 only
};

export type CodexParsedChunk =
  | {
      type: "action_confirmation";
      toolName: string;
      params: unknown;
      runId: string;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      id?: string;
      name: string;
      result: { success: boolean; data: unknown; summary: string };
      refs: LiftedOutputRef[];
    }
  | { type: "reasoning"; delta: string };

export function extractConfirmPayload(text: string): string | null {
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

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readToolResultContentCandidate(item: Record<string, unknown>): unknown {
  const direct = item.content ?? item.output;
  if (direct !== undefined) return direct;

  const result = parseObject(item.result);
  return result.content ?? result.output ?? result.result ?? item.result;
}

export function normalizeToolResultText(item: Record<string, unknown>): string {
  const value = readToolResultContentCandidate(item);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        const record = parseObject(entry);
        if (asString(record.type, "") === "text") {
          return asString(record.text, "");
        }
        return typeof entry === "string" ? entry : "";
      })
      .join("");
  }
  return stringifyUnknown(value);
}

/** Minimal structural screen — authoritative validation happens server-side. */
export function liftOutputRefs(text: string): LiftedOutputRef[] | null {
  try {
    const parsed = JSON.parse(text) as { outputRefs?: unknown };
    if (!Array.isArray(parsed?.outputRefs) || parsed.outputRefs.length === 0) return null;
    const screened: LiftedOutputRef[] = [];
    for (const r of parsed.outputRefs) {
      const rec = parseObject(r);
      const v = rec.v === 2 ? 2 : rec.v === 1 ? 1 : null;
      if (v === null) continue;
      if (rec.action !== "created" && rec.action !== "referenced") continue;
      const action = rec.action;
      const kind = LIFTED_SHOW_REF_KINDS.includes(rec.kind as LiftedShowRefKind)
        ? (rec.kind as LiftedShowRefKind)
        : null;
      if (kind === null) continue;
      if (v === 1 && kind !== "artifact") continue; // v1 is artifact-only
      if (typeof rec.id !== "string" || rec.id.length === 0) continue;
      const maxId = v === 1 ? 256 : 2048;
      if (rec.id.length > maxId) continue;

      const versionId = typeof rec.versionId === "string" ? rec.versionId : null;
      const versionNumber =
        typeof rec.versionNumber === "number" && Number.isInteger(rec.versionNumber) && rec.versionNumber > 0
          ? rec.versionNumber
          : null;
      const title = typeof rec.title === "string" ? rec.title : null;
      const toolCallId = typeof rec.toolCallId === "string" ? rec.toolCallId : null;
      const mimeType = typeof rec.mimeType === "string" ? rec.mimeType : null;

      if (v === 1) {
        // Byte-identical to the pre-v2 shape: NO viewerKind / provenance keys.
        screened.push({ v: 1, kind, id: rec.id, versionId, versionNumber, title, action, toolCallId, mimeType });
        continue;
      }

      // v === 2
      const viewerKind = typeof rec.viewerKind === "string" ? rec.viewerKind : null;
      let provenance: LiftedProvenance | null = null;
      if (rec.provenance !== undefined && rec.provenance !== null) {
        const pv = parseObject(rec.provenance);
        const surfaceOk = pv.surface === "commander" || pv.surface === "discussion" || pv.surface === "workspace";
        const entityOk = typeof pv.entityId === "string" && pv.entityId.length > 0;
        const seqOk = typeof pv.seq === "number" && Number.isInteger(pv.seq) && pv.seq >= 0;
        const emittedOk = typeof pv.emittedAt === "string" && pv.emittedAt.length > 0;
        if (!surfaceOk || !entityOk || !seqOk || !emittedOk) continue; // present-but-malformed -> reject the ref
        provenance = {
          surface: pv.surface as LiftedProvenance["surface"],
          entityId: pv.entityId as string,
          seq: pv.seq as number,
          emittedAt: pv.emittedAt as string,
          agentId: typeof pv.agentId === "string" ? pv.agentId : null,
          runId: typeof pv.runId === "string" ? pv.runId : null,
          messageId: typeof pv.messageId === "string" ? pv.messageId : null,
        };
      }
      screened.push({ v: 2, kind, id: rec.id, versionId, versionNumber, title, viewerKind, action, toolCallId, mimeType, provenance });
    }
    return screened.length > 0 ? screened.slice(0, 20) : null;
  } catch {
    return null;
  }
}

const CODEX_ROLLOUT_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i;

/**
 * Strip codex's benign "state db missing rollout path" stderr noise lines.
 * Shared by BOTH stderr paths (exec: runChildProcess capture in execute.ts;
 * app-server: spawnAppServerClient onStderr in execute-app-server.ts) so their
 * logging matches. Lives here — not in execute.ts — to avoid an
 * execute ↔ execute-app-server module cycle.
 */
export function stripCodexRolloutNoise(text: string): string {
  const parts = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      kept.push(part);
      continue;
    }
    if (CODEX_ROLLOUT_NOISE_RE.test(trimmed)) continue;
    kept.push(part);
  }
  return kept.join("\n");
}

export function parseActionConfirmation(item: Record<string, unknown>): CodexParsedChunk | null {
  const text = normalizeToolResultText(item);
  const confirmPayload = extractConfirmPayload(text);
  if (!confirmPayload) return null;

  try {
    const payload = parseObject(JSON.parse(confirmPayload));
    const toolName = asString(payload.toolName, "");
    if (!toolName) return null;
    return {
      type: "action_confirmation",
      toolName,
      params: payload.params,
      runId: asString(payload.confirmId, "") || randomUUID(),
    };
  } catch {
    return null;
  }
}
