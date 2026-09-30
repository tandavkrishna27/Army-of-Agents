import { z } from "zod";
import { timestampV1Schema } from "./job.js";
import { addForbiddenWireKeyIssues } from "./wire-safety.js";

// -----------------------------------------------------------------------------
// Stable, framework-neutral protocol error vocabulary.
//
// `ProtocolErrorV1` is the ONE error envelope every operation may return. The
// code set is CLOSED — an unknown code fails closed (`protocolErrorCodeSchema`
// rejects it and `isKnownProtocolErrorCode` returns false), so a peer can never
// widen the vocabulary on the wire. Only `throttled` and `internal_unavailable`
// are retryable and therefore carry a bounded `retryAfterMs`; every other code
// forbids it. Details are bounded and redacted and MUST NOT disclose whether a
// foreign-tenant resource exists — the schema keeps `message`/`detail` bounded,
// forbids credential-bearing keys recursively, and requires the explicit
// `redaction: "secret"` marker; producers additionally strip existence signals.
//
// Runtime source imports only `zod` + relative modules and touches no Node API.
// -----------------------------------------------------------------------------

/** The stable, CLOSED V1 protocol error codes, in canonical order. */
export const PROTOCOL_ERROR_CODES = [
  "malformed",
  "unauthorized",
  "incompatible_protocol",
  "incompatible_capability",
  "incompatible_policy",
  "stale_fence",
  "sequence_gap",
  "target_revoked",
  "event_hash_mismatch",
  "throttled",
  "payload_too_large",
  "attempt_terminal",
  "internal_unavailable",
] as const;
export const protocolErrorCodeSchema = z.enum(PROTOCOL_ERROR_CODES);
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

/** The only codes that carry a bounded `retryAfterMs` retry hint. */
export const RETRYABLE_PROTOCOL_ERROR_CODES = ["throttled", "internal_unavailable"] as const;
const RETRYABLE_SET: ReadonlySet<string> = new Set<string>(RETRYABLE_PROTOCOL_ERROR_CODES);

/** True iff `code` is a retryable protocol error code. */
export function isRetryableProtocolErrorCode(code: string): boolean {
  return RETRYABLE_SET.has(code);
}

const KNOWN_SET: ReadonlySet<string> = new Set<string>(PROTOCOL_ERROR_CODES);

/** Fail-closed membership test: an unknown / non-string value is NOT a known code. */
export function isKnownProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === "string" && KNOWN_SET.has(value);
}

const nonNegativeIntSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The bounded detail limits (bounds after UTF-8 encoding are the producer's job;
 * the schema caps key count and per-value length so a detail bag cannot smuggle a
 * large or credential-bearing payload). */
export const PROTOCOL_ERROR_DETAIL_LIMITS = {
  maxKeys: 16,
  maxKeyChars: 100,
  maxValueChars: 1000,
  maxMessageChars: 1000,
} as const;

const detailSchema = z.record(
  z.string().min(1).max(PROTOCOL_ERROR_DETAIL_LIMITS.maxKeyChars),
  z.string().max(PROTOCOL_ERROR_DETAIL_LIMITS.maxValueChars),
);

/**
 * The stable protocol error envelope. `correlationId` is nullable because a
 * request that failed before correlation was read (a truly malformed frame) has
 * none. `retryAfterMs` is non-null EXACTLY for the retryable codes and null for
 * every other code. `detail` is a bounded string→string bag; recursive
 * wire-safety rejects any credential-bearing key, and the required
 * `redaction: "secret"` marker records that the producer redacted secrets and
 * existence signals.
 */
export const protocolErrorV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    code: protocolErrorCodeSchema,
    correlationId: z.string().uuid().nullable(),
    message: z.string().max(PROTOCOL_ERROR_DETAIL_LIMITS.maxMessageChars),
    retryAfterMs: nonNegativeIntSchema.nullable(),
    serverTime: timestampV1Schema,
    redaction: z.literal("secret"),
    detail: detailSchema,
  })
  .strict()
  .superRefine((error, ctx) => {
    addForbiddenWireKeyIssues(error, ctx);
    if (Object.keys(error.detail).length > PROTOCOL_ERROR_DETAIL_LIMITS.maxKeys) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["detail"], message: `at most ${PROTOCOL_ERROR_DETAIL_LIMITS.maxKeys} detail keys` });
    }
    if (isRetryableProtocolErrorCode(error.code)) {
      if (error.retryAfterMs === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retryAfterMs"], message: `${error.code} requires a bounded retryAfterMs` });
      }
    } else if (error.retryAfterMs !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retryAfterMs"], message: "retryAfterMs is only valid for a retryable error code" });
    }
  });
export type ProtocolErrorV1 = z.infer<typeof protocolErrorV1Schema>;
