export declare const MIN_PROTOCOL_VERSION: 1;
export declare const PROTOCOL_VERSION: 1;
/** An inclusive protocol-version range advertised by a peer. The pure negotiation
 * function below assumes callers have already validated these are positive
 * integers with `min <= max` (the Zod schemas that carry a range enforce that). */
export interface ProtocolVersionRange {
    min: number;
    max: number;
}
/**
 * Negotiate the single protocol version two peers will speak: the highest
 * version inside the overlap of the control-plane and worker ranges, or `null`
 * when the ranges do not overlap. This is intentionally a pure integer function
 * with no I/O — the N-1 rollout case (`{1,2}` vs `{1,1}` → 1) is exercised as a
 * unit test, NOT the frozen-consumer cross-version proof (that lands in PRT-007).
 */
export declare function negotiateProtocolVersion(controlPlane: ProtocolVersionRange, worker: ProtocolVersionRange): number | null;
