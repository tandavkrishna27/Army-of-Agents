/**
 * runtime-hooks.ts — W5b PreToolUse permission bridge route.
 *
 * The claude-local adapter's PreToolUse hook POSTs here (blocking) to ask
 * whether a tool call is permitted. This route authenticates the per-run
 * bearer token, builds a permission prompt, and asks the run's decision broker
 * for a bounded (timeout-aware) answer.
 *
 * FAIL-SAFE CONTRACT: this endpoint ALWAYS returns HTTP 200 with a well-formed
 * PreToolUse hook response. It NEVER returns 401/4xx/5xx and NEVER hangs
 * indefinitely — any auth failure, timeout, or thrown error maps to a "deny"
 * decision. A hook error must not fail-open (allow) nor block the CLI forever.
 */

import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import {
  RUNTIME_HOOK_PATH,
  RUNTIME_HOOK_BLOCK_TIMEOUT_SEC,
} from "@armyofagents/adapter-utils";
import type { AdapterRuntimePermissionAnswer } from "@armyofagents/adapter-utils";
import { resolveRuntimeHook } from "../services/runtime-hook-registry.js";
import {
  buildPermissionPromptFromHook,
  mapAnswerToHookResponse,
  type PreToolUsePayload,
} from "../services/runtime-hook-bridge.js";
import { logger } from "../middleware/logger.js";

const DENY_RESPONSE = mapAnswerToHookResponse({
  decision: "deny",
} as AdapterRuntimePermissionAnswer);

function sendDeny(res: Response): void {
  res.status(200).json(DENY_RESPONSE);
}

function readBearerToken(req: Request): string | null {
  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function readPayloadCompanyId(body: unknown): string | null {
  if (body && typeof body === "object" && "companyId" in body) {
    const value = (body as Record<string, unknown>).companyId;
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  return null;
}

export function runtimeHooksRoutes(_db: Db): Router {
  const router = Router();

  router.post(RUNTIME_HOOK_PATH, async (req: Request, res: Response) => {
    try {
      const token = readBearerToken(req);
      if (!token) {
        // No token → deny (fail-safe). Do NOT 401 — the hook must not fail-open
        // or surface an auth error the CLI can't recover from.
        return sendDeny(res);
      }

      const entry = resolveRuntimeHook(token);
      if (!entry) {
        // Unknown / expired / malformed token → deny.
        return sendDeny(res);
      }

      // Defense-in-depth: the token is the source of truth for company scope,
      // but if the payload carries a companyId it MUST match the token entry.
      const payloadCompanyId = readPayloadCompanyId(req.body);
      if (payloadCompanyId != null && payloadCompanyId !== entry.companyId) {
        return sendDeny(res);
      }

      const prompt = buildPermissionPromptFromHook(req.body as PreToolUsePayload);

      const result = await entry.broker.requestPermissionBounded(
        prompt,
        RUNTIME_HOOK_BLOCK_TIMEOUT_SEC * 1000,
      );

      if ("timedOut" in result) {
        // Timed out waiting for a human → deny (fail-safe).
        return sendDeny(res);
      }

      return res.status(200).json(mapAnswerToHookResponse(result));
    } catch (error) {
      // Any thrown error (incl. RuntimeDecisionCancelledError) → deny.
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "runtime-hook permission-request failed; denying",
      );
      return sendDeny(res);
    }
  });

  return router;
}
