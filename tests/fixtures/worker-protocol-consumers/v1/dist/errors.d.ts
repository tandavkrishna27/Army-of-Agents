import { z } from "zod";
/** The stable, CLOSED V1 protocol error codes, in canonical order. */
export declare const PROTOCOL_ERROR_CODES: readonly ["malformed", "unauthorized", "incompatible_protocol", "incompatible_capability", "incompatible_policy", "stale_fence", "sequence_gap", "target_revoked", "event_hash_mismatch", "throttled", "payload_too_large", "attempt_terminal", "internal_unavailable"];
export declare const protocolErrorCodeSchema: z.ZodEnum<["malformed", "unauthorized", "incompatible_protocol", "incompatible_capability", "incompatible_policy", "stale_fence", "sequence_gap", "target_revoked", "event_hash_mismatch", "throttled", "payload_too_large", "attempt_terminal", "internal_unavailable"]>;
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];
/** The only codes that carry a bounded `retryAfterMs` retry hint. */
export declare const RETRYABLE_PROTOCOL_ERROR_CODES: readonly ["throttled", "internal_unavailable"];
/** True iff `code` is a retryable protocol error code. */
export declare function isRetryableProtocolErrorCode(code: string): boolean;
/** Fail-closed membership test: an unknown / non-string value is NOT a known code. */
export declare function isKnownProtocolErrorCode(value: unknown): value is ProtocolErrorCode;
/** The bounded detail limits (bounds after UTF-8 encoding are the producer's job;
 * the schema caps key count and per-value length so a detail bag cannot smuggle a
 * large or credential-bearing payload). */
export declare const PROTOCOL_ERROR_DETAIL_LIMITS: {
    readonly maxKeys: 16;
    readonly maxKeyChars: 100;
    readonly maxValueChars: 1000;
    readonly maxMessageChars: 1000;
};
/**
 * The stable protocol error envelope. `correlationId` is nullable because a
 * request that failed before correlation was read (a truly malformed frame) has
 * none. `retryAfterMs` is non-null EXACTLY for the retryable codes and null for
 * every other code. `detail` is a bounded string→string bag; recursive
 * wire-safety rejects any credential-bearing key, and the required
 * `redaction: "secret"` marker records that the producer redacted secrets and
 * existence signals.
 */
export declare const protocolErrorV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    code: z.ZodEnum<["malformed", "unauthorized", "incompatible_protocol", "incompatible_capability", "incompatible_policy", "stale_fence", "sequence_gap", "target_revoked", "event_hash_mismatch", "throttled", "payload_too_large", "attempt_terminal", "internal_unavailable"]>;
    correlationId: z.ZodNullable<z.ZodString>;
    message: z.ZodString;
    retryAfterMs: z.ZodNullable<z.ZodNumber>;
    serverTime: z.ZodString;
    redaction: z.ZodLiteral<"secret">;
    detail: z.ZodRecord<z.ZodString, z.ZodString>;
}, "strict", z.ZodTypeAny, {
    code: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    message: string;
    protocolVersion: 1;
    redaction: "secret";
    detail: Record<string, string>;
    correlationId: string | null;
    retryAfterMs: number | null;
    serverTime: string;
}, {
    code: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    message: string;
    protocolVersion: 1;
    redaction: "secret";
    detail: Record<string, string>;
    correlationId: string | null;
    retryAfterMs: number | null;
    serverTime: string;
}>, {
    code: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    message: string;
    protocolVersion: 1;
    redaction: "secret";
    detail: Record<string, string>;
    correlationId: string | null;
    retryAfterMs: number | null;
    serverTime: string;
}, {
    code: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    message: string;
    protocolVersion: 1;
    redaction: "secret";
    detail: Record<string, string>;
    correlationId: string | null;
    retryAfterMs: number | null;
    serverTime: string;
}>;
export type ProtocolErrorV1 = z.infer<typeof protocolErrorV1Schema>;
