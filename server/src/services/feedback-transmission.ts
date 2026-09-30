import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Env-based feedback + plugin-telemetry transmission (Phase I.2 Task 11 /
// PF.1 + PF.2). Unset AOA_FEEDBACK_ENDPOINT → local-only mode (callers fall
// back to writeBundleLocally / log-and-discard). Set → POST JSON to the
// configured endpoint with optional Bearer auth.
//
// This module is AoA-beyond-Paperclip — Paperclip has no equivalent. Shape
// decisions (env-var names, bundle envelope) are locked by the Phase I.2 plan
// and documented in docs/telemetry.md.
// ---------------------------------------------------------------------------

export const ENDPOINT_ENV = "AOA_FEEDBACK_ENDPOINT";
export const API_KEY_ENV = "AOA_FEEDBACK_API_KEY";

export interface TransmissionResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export function isTransmissionEnabled(): boolean {
  return Boolean(process.env[ENDPOINT_ENV]);
}

/**
 * POST a feedback bundle (or arbitrary JSON-serialisable envelope) to the
 * configured endpoint. Returns a structured result — never throws. Callers
 * decide whether to fall back to local persistence on a non-ok result.
 *
 * Redaction is NOT applied here — callers must run
 * `feedback-redaction.ts`'s pipeline first (§F.5). This function is pure
 * transport.
 */
export async function transmitFeedbackBundle(bundle: unknown): Promise<TransmissionResult> {
  const endpoint = process.env[ENDPOINT_ENV];
  if (!endpoint) return { ok: false, error: "not_configured" };

  const apiKey = process.env[API_KEY_ENV];
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(bundle),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, endpoint }, "feedback transmission non-2xx");
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message, endpoint }, "feedback transmission threw");
    return { ok: false, error: message };
  }
}

/**
 * Fire-and-forget plugin telemetry transmission. Plugins call
 * `ctx.telemetry.track(event, dims)` which reaches the host services layer;
 * the host calls this function to hand the event off for transmission.
 *
 * Semantics: never throw, never block. If the endpoint is unset, this is a
 * no-op (the host already logs at debug level). If the endpoint is set, the
 * POST runs in the background — the promise is not awaited by the plugin.
 */
export async function transmitPluginTelemetry(
  event: string,
  dims: Record<string, unknown> | undefined,
): Promise<void> {
  if (!isTransmissionEnabled()) return;
  const envelope = {
    kind: "plugin_telemetry" as const,
    event,
    dims: dims ?? {},
    timestamp: new Date().toISOString(),
  };
  // Launch and detach — host should not wait on the network round-trip.
  void transmitFeedbackBundle(envelope).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug({ err: message, event }, "plugin telemetry fire-and-forget failed");
  });
}
