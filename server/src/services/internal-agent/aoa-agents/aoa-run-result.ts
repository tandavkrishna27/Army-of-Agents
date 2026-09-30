/**
 * Result returned by runAoaAgent (T1.0 — failure contract).
 *
 * Before T1.0: runAoaAgent returned `void`, swallowed errors, and the
 * dispatcher inferred success by the absence of a thrown exception. This
 * silently marked wakeups as 'succeeded' whenever the adapter exited
 * cleanly even if the run produced no useful work. Codex outside-voice
 * caught this (findings #1, #2, #3).
 *
 * After T1.0: runAoaAgent returns AoaRunResult so the dispatcher can:
 *   1. Set agent_wakeup_requests.status from the actual outcome
 *      (succeeded/failed reflecting what the adapter reported, not just
 *      whether the runner threw)
 *   2. Persist the adapter's reported usage + cost to internal_agent_runs
 *      (claude/codex/opencode/gemini adapters all populate these on the
 *      AdapterExecutionResult; today the data is discarded)
 *   3. Use the failure path (T1.5 silent-failure guard, T1.9
 *      failure-storm brake) without inventing a third channel
 *
 * The runner still does its own internal_agent_runs writes (status,
 * duration, errorMessage) — that is part of its run lifecycle and was
 * already correct. AoaRunResult just exposes the same truth to callers
 * for their own bookkeeping (the wakeup row, the rate brake, etc.).
 *
 * Cost convention:
 *   - costCents is an integer (cents). Computed from adapter result.costUsd
 *     via Math.round(costUsd * 100). Null when the adapter doesn't report
 *     cost (e.g. CLI subscription mode where billing is flat).
 *   - usage carries the raw token counts from the adapter so the
 *     dispatcher can persist tokenUsage JSONB.
 */

import type { UsageSummary } from "../../../adapters/types.js";
import { detectTransportFailure } from "../transport-failure.js";

export type AoaRunStatus = "succeeded" | "failed";

/**
 * Translate an AdapterExecutionResult into an AoaRunResult. Pure function;
 * exhaustively unit-tested. Centralizes the success/failure decision so
 * the runner doesn't need to repeat the logic everywhere: the runner's catch
 * path builds its own failed result inline; this function owns the success-path
 * decision (a transport-closed-on-exit-0 is by definition the non-throwing case,
 * so detecting it here is correct).
 *
 * Task 9 (loud-failure detection): in addition to the exitCode/errorMessage
 * checks, this scans the adapter's reported errorMessage AND the raw
 * resultJson stdout/stderr for a transport-class marker (e.g. "Transport
 * closed"). When found it FORCES status='failed' with a transport-specific
 * message — even when the CLI exited 0 with a clean (null) errorMessage,
 * which is exactly the silent-failure that shipped the codex MCP-bridge bug
 * (codex exits 0, errorMessage is null, and the "Transport closed" text only
 * lives in raw output). gemini's error stream lacks a clean MCP marker, so
 * its caller passes markerSupported:false → 'unknown', never a false-positive.
 *
 * KNOWN GAP (gemini): gemini-local sets resultJson = parsed.resultEvent ?? {stdout,stderr};
 * when a parsed event object exists, resultJson has no string stdout/stderr, so a gemini
 * transport failure whose marker lives only in the raw streams is NOT detected → 'succeeded'.
 * Accepted: gemini's error stream lacks a clean MCP marker (markerSupported:false), so we
 * prefer no-false-positive over best-effort detection for it.
 *
 * The detector's `status:"unknown"` (returned for markerSupported:false with no marker) is
 * intentionally treated as NOT failed here — we never force-fail on an unprovable signal.
 */
export function buildAoaRunResultFromAdapter(
  adapterResult: {
    exitCode: number | null;
    errorMessage?: string | null;
    usage?: UsageSummary;
    costUsd?: number | null;
    resultJson?: Record<string, unknown> | null;
  },
  opts?: { mcpAttempted?: boolean; markerSupported?: boolean },
): AoaRunResult {
  const rawStdout = typeof adapterResult.resultJson?.stdout === "string" ? adapterResult.resultJson.stdout : "";
  const rawStderr = typeof adapterResult.resultJson?.stderr === "string" ? adapterResult.resultJson.stderr : "";
  const transport = detectTransportFailure({
    parsedErrorMessages: adapterResult.errorMessage ? [adapterResult.errorMessage] : [],
    rawStdout,
    rawStderr,
    mcpAttempted: opts?.mcpAttempted,
    markerSupported: opts?.markerSupported,
  });

  const failed =
    transport.failed
    || (adapterResult.exitCode !== null && adapterResult.exitCode !== 0)
    || Boolean(adapterResult.errorMessage);

  const costCents = typeof adapterResult.costUsd === "number"
    ? Math.round(adapterResult.costUsd * 100)
    : null;
  return {
    status: failed ? "failed" : "succeeded",
    errorMessage: transport.failed
      ? `AoA MCP bridge transport failed: ${transport.detail}`
      : failed
        ? (adapterResult.errorMessage ?? `exit ${adapterResult.exitCode}`)
        : undefined,
    costCents,
    usage: adapterResult.usage,
  };
}

export interface AoaRunResult {
  /** Internal agent run row id, when runAoaAgent created one. */
  runId?: string | null;

  /** Terminal outcome. 'failed' covers: adapter threw, adapter returned
   *  non-zero exit code, adapter returned errorMessage, or the runner's
   *  own guards (e.g. silent-failure guard from T1.5) tripped. */
  status: AoaRunStatus;

  /** Human-readable failure summary. Set when status='failed'; omitted
   *  on success. Sourced from adapter.errorMessage when the adapter
   *  reports one, otherwise the caught exception's message. */
  errorMessage?: string;

  /** Integer cents, computed from adapter.costUsd. Null when the adapter
   *  ran in subscription/free mode and reports no per-run cost. The
   *  dispatcher's rate-brake gates on costCents > 0 so a null/zero value
   *  intentionally does not count toward the LLM-spend safety net (T1.1).
   *  A separate failure-storm brake (T1.9) gates on status='failed'. */
  costCents?: number | null;

  /** Raw usage counts from the adapter, persisted as internal_agent_runs.tokenUsage
   *  JSONB. Pass through verbatim from AdapterExecutionResult.usage. */
  usage?: UsageSummary;
}
