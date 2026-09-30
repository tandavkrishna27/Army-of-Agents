// server/src/middleware/rate-limit.ts
//
// Per-route rate limiting (Sprint 4 finding S4-F). Uses `express-rate-limit`
// with the standardized draft-7 RateLimit-* response headers. The default
// store is the library's in-memory bucket — fine for single-instance
// deployments. Multi-instance deployments need a Redis-backed store
// (`rate-limit-redis`); that's a deferred follow-up.
//
// All limiters constructed here are module-level constants so requests
// across the process share the same memory bucket. Constructing a new
// limiter per request would defeat rate limiting entirely.
//
// Note on trust-proxy + req.ip:
// IP-keyed rate limits read req.ip, which honors Express's `trust proxy`
// setting. Operators behind a reverse proxy must set AOA_TRUST_PROXY
// (env var, parsed in config.ts) to a hop count or CIDR list — see
// docs/deploy/environment-variables.md. Default is `false` to prevent
// X-Forwarded-For spoofing on directly-exposed deployments.

import type { Request, RequestHandler, Response } from "express";
import {
  rateLimit,
  type Options as RateLimitLibOptions,
} from "express-rate-limit";

/**
 * The kind of key used to bucket requests for rate limiting.
 *
 * - `ip`     — bucket by `req.ip` (socket IP, pre-proxy-trust). Use for
 *              unauthenticated endpoints (sign-in, CLI auth challenges).
 *
 * - `actor`  — bucket by `req.actor.userId` (board) or `req.actor.agentId`
 *              (agent). Falls back to `req.ip` when `req.actor.type === "none"`.
 *              Use for authenticated billing-sensitive endpoints (transcribe,
 *              internal-agent chat) so a single account drains its own quota
 *              instead of a shared IP bucket.
 */
export type RateLimitKey = "ip" | "actor";

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed in the window per key. */
  max: number;
  /** How to bucket requests — by IP or by authenticated actor. */
  keyBy: RateLimitKey;
  /**
   * Optional human-readable label for logs; not surfaced in the 429 body
   * (the body is fixed JSON for client-machine-readability).
   */
  message?: string;
}

interface RateLimitedJsonBody {
  error: "rate_limited";
  retryAfter: number;
}

function actorKey(req: Request): string {
  const actor = req.actor;
  // Defensive: a rate limiter must never 500 a request. In production
  // `actorMiddleware` always sets `req.actor` (at minimum `{type:"none"}`), but a
  // route mounted without it must degrade to an IP bucket, not crash.
  if (!actor) {
    return ipKey(req);
  }
  if (actor.type === "board" && actor.userId) {
    return `user:${actor.userId}`;
  }
  if (actor.type === "agent" && actor.agentId) {
    return `agent:${actor.agentId}`;
  }
  if (actor.type === "mcp" && actor.userId) {
    return `mcp:${actor.userId}`;
  }
  // Fallback for unauthenticated callers — bucket by IP. This matches the
  // documented behaviour (RateLimitOptions.keyBy = "actor" with type "none"
  // falls back to ip).
  return `ip:${req.ip ?? "unknown"}`;
}

function ipKey(req: Request): string {
  // Express returns "" if no socket info is available. Treat that as a
  // single shared bucket rather than throwing — denying requests with no
  // detectable IP is worse than under-bucketing in this edge case.
  return `ip:${req.ip ?? "unknown"}`;
}

/**
 * Construct a per-route rate limiter. The returned middleware is safe to
 * assign as a constant; do NOT construct one per-request, or each request
 * gets its own (empty) bucket.
 */
export function createRateLimiter(opts: RateLimitOptions): RequestHandler {
  const keyGenerator = opts.keyBy === "ip" ? ipKey : actorKey;

  // Body type isn't strictly required for express-rate-limit but we want
  // to lock the response shape so downstream consumers (UI, CLI clients)
  // don't drift.
  const body: RateLimitedJsonBody = { error: "rate_limited", retryAfter: 0 };

  const baseOptions: Partial<RateLimitLibOptions> = {
    windowMs: opts.windowMs,
    limit: opts.max,
    keyGenerator,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Disable express-rate-limit's per-process startup warning. The warning
    // is intended for serverless/clustered deployments where the in-memory
    // store doesn't share state across instances; AoA runs as a single
    // process today (Redis store is the documented multi-instance path).
    validate: false,
    handler: (req: Request, res: Response) => {
      // express-rate-limit attaches `req.rateLimit` with the reset time.
      // Compute retryAfter as ceil((resetMs - now) / 1000).
      const resetMs =
        (req as Request & { rateLimit?: { resetTime?: Date | number } })
          .rateLimit?.resetTime instanceof Date
          ? (
              (req as Request & { rateLimit: { resetTime: Date } }).rateLimit
                .resetTime as Date
            ).getTime()
          : Math.floor(Date.now() / 1000) * 1000 + opts.windowMs;
      const retryAfterSec = Math.max(
        1,
        Math.ceil((resetMs - Date.now()) / 1000)
      );
      res.status(429).json({
        ...body,
        retryAfter: retryAfterSec,
      });
    },
  };

  return rateLimit(baseOptions);
}

// ── Named limiters ────────────────────────────────────────────────────────────
// One module-level limiter per route group. These are the buckets the route
// files import.

const ONE_MINUTE = 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

/**
 * Sign-in (better-auth `/api/auth/sign-in/email`). 10 requests per minute
 * per IP. Bucket by IP to defend against credential stuffing — a single
 * attacker IP can't attempt more than 10 distinct passwords per minute.
 */
export const signinLimiter: RequestHandler = createRateLimiter({
  windowMs: ONE_MINUTE,
  max: 10,
  keyBy: "ip",
  message: "Too many sign-in attempts; try again shortly",
});

/**
 * Sign-up (better-auth `/api/auth/sign-up/email`). 5 per hour per IP.
 * Account creation is a high-value action and abuse is largely from
 * scripted IPs; an hour window matches the SaaS norm.
 */
export const signupLimiter: RequestHandler = createRateLimiter({
  windowMs: ONE_HOUR,
  max: 5,
  keyBy: "ip",
  message: "Too many sign-up attempts; try again later",
});

/**
 * Forgot-password (better-auth `/api/auth/forget-password`). 5 per hour
 * per IP. Same shape as sign-up — account-discovery and email-spam
 * defense.
 */
export const forgotPasswordLimiter: RequestHandler = createRateLimiter({
  windowMs: ONE_HOUR,
  max: 5,
  keyBy: "ip",
  message: "Too many password-reset requests; try again later",
});

/**
 * CLI auth challenge creation (`POST /api/cli-auth/challenges`). 5 per
 * minute per IP. The endpoint is unauthenticated by design (the CLI has
 * no token yet) and writes 10-minute-TTL rows to `cli_auth_challenges`.
 * Without rate limiting, an attacker can flood the table; replaces the
 * long-standing TODO at `cli-auth.ts:29`.
 */
export const cliAuthChallengeLimiter: RequestHandler = createRateLimiter({
  windowMs: ONE_MINUTE,
  max: 5,
  keyBy: "ip",
  message: "Too many CLI auth challenge requests; try again shortly",
});

/**
 * Public plugin webhooks. 300 requests per minute per source IP. Webhook
 * handlers are intentionally unauthenticated, persist an audit row, and wake a
 * plugin worker, so the host must bound abuse before UUID lookup or any DB/RPC
 * work. Signature verification remains the individual plugin's responsibility.
 */
export const pluginWebhookLimiter: RequestHandler = createRateLimiter({
  windowMs: ONE_MINUTE,
  max: 300,
  keyBy: "ip",
  message: "Plugin webhook rate limit exceeded; try again shortly",
});

/**
 * Transcribe (`POST /companies/:cid/transcribe`). 30 per minute per actor.
 * Bucket by authenticated user/agent so a compromised account hits its own
 * limit instead of sharing a tenant-wide IP bucket. Whisper API is ~$0.006
 * per minute of audio — 30/min/actor caps the per-account billing-drain
 * at roughly $0.18/minute even if an attacker submits the maximum 25 MB
 * file every time.
 */
export const transcribeLimiter: RequestHandler = createRateLimiter({
  windowMs: ONE_MINUTE,
  max: 30,
  keyBy: "actor",
  message: "Transcription rate limit exceeded; try again shortly",
});

/**
 * Internal-agent chat (`POST /companies/:cid/internal-agent/chat`). 60 per
 * minute per actor. The chat endpoint is LLM-billed; the SSE-streaming
 * variant of the same endpoint is covered by the same limiter (one route).
 */
export const internalAgentChatLimiter: RequestHandler = createRateLimiter({
  windowMs: ONE_MINUTE,
  max: 60,
  keyBy: "actor",
  message: "Internal-agent chat rate limit exceeded; try again shortly",
});

/**
 * Semantic memory search / find-similar
 * (`GET /companies/:cid/memory/{search,find-similar}`). Each request computes an
 * embedding via a paid provider API, so without a cap an authenticated actor
 * could drive unbounded embedding spend (cost-amplification / billing-drain
 * DoS). 60 per minute per actor caps the per-account cost.
 */
export const embeddingSearchLimiter: RequestHandler = createRateLimiter({
  windowMs: ONE_MINUTE,
  max: 60,
  keyBy: "actor",
  message: "Memory search rate limit exceeded; try again shortly",
});

/**
 * Runtime preview proxy. Browser previews can be chatty (assets, HMR polling,
 * source maps) but are still scoped to the authenticated AoA actor.
 */
export const previewProxyLimiter: RequestHandler = createRateLimiter({
  windowMs: ONE_MINUTE,
  max: 600,
  keyBy: "actor",
  message: "Preview proxy rate limit exceeded; try again shortly",
});

/**
 * Office document server-render (`GET /assets/:id/render` and the memory-scoped
 * `GET /companies/:cid/memory/assets/:id/render`). Each request fetches the file
 * and runs mammoth (DOCX) / exceljs (XLSX) over it — a CPU- and memory-heavy
 * parse. Bucket by authenticated actor so one account's render storm hits its
 * own limit. 60/min/actor comfortably covers a human clicking through previews
 * while capping automated abuse; the render input is additionally bounded by
 * OFFICE_RENDER_MAX_BYTES (office-render-limits.ts).
 */
export const officeRenderLimiter: RequestHandler = createRateLimiter({
  windowMs: ONE_MINUTE,
  max: 60,
  keyBy: "actor",
  message: "Office render rate limit exceeded; try again shortly",
});
