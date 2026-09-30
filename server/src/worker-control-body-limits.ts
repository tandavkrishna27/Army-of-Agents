import {
  OPERATION_DESCRIPTORS,
  WORKER_PROTOCOL_OPERATIONS,
} from "@armyofagents/worker-protocol";

/**
 * BRW-003d-1 — the body limits for the worker-control HTTP surface.
 *
 * A LEAF MODULE ON PURPOSE. `app.ts` needs these numbers at parser-mount time,
 * which is long before the flag check that dynamically imports the
 * worker-control / job-leasing / job-control-metrics graph. Importing anything
 * from `routes/worker-control.js` here would defeat that lazy load, so this file
 * depends on the frozen protocol package and nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `express.json()` with no `limit` applies express's 100 KB default. The frozen
 * `OPERATION_DESCRIPTORS` declare `maxRequestBytes` well above that for five of
 * the ten operations — `event_upload` at 4 MiB is 41x over. The consequences,
 * both measured:
 *
 *   1. LEGAL REQUESTS WERE REFUSED. A 200 KB event batch is inside the frozen
 *      ceiling and was rejected anyway.
 *   2. THE REFUSAL HAD THE WRONG SHAPE. body-parser's 413 is rendered by
 *      `middleware/error-handler.ts` as a plain `{error: message}`, NOT a
 *      `ProtocolErrorV1` envelope. `event_upload` carries
 *      `retry: "idempotent_retry"` and a closed error vocabulary; a worker that
 *      receives an unclassifiable 413 cannot route it through that retry rule.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ WHY THE LIMIT IS STRICTLY GREATER THAN THE CONTRACT, NOT EQUAL TO IT
 *
 * This is the non-obvious part, and it was verified by running express rather
 * than by reasoning about it. Setting the mount to exactly the contract value —
 * the natural reading of "align the limit with the contract" — DOES NOT FIX THE
 * DEFECT. Measured, with a contract of 300 bytes and a 340-byte body:
 *
 *   mount == contract  ->  413 {"envelope":"NOT-protocol","err":"entity.too.large"}
 *   mount  > contract  ->  200 {"envelope":"protocol","code":"payload_too_large"}
 *
 * With mount == contract, express still rejects first and the handler's own
 * ceiling guard stays dead; all that changes is the threshold at which the wrong
 * shape is emitted. The headroom is what lets the handler observe an oversized
 * body and refuse it in the protocol's own vocabulary.
 *
 * Bodies above the mount still get a bare 413. That is unavoidable without
 * unbounded buffering, and it now applies only to payloads already past the
 * contract ceiling plus headroom.
 */
export const WORKER_CONTROL_BODY_HEADROOM_BYTES = 64 * 1024;

/** `app.use` prefix covering every worker-control operation route. */
export const WORKER_CONTROL_PATH_PREFIX = "/api/worker-control";

/** The one operation whose declared ceiling is orders of magnitude above the rest. */
export const WORKER_CONTROL_EVENTS_PATH = "/api/worker-control/events";

const declaredBytes = (op: (typeof WORKER_PROTOCOL_OPERATIONS)[number]): number =>
  OPERATION_DESCRIPTORS[op].maxRequestBytes;

/**
 * Limit for every worker-control path EXCEPT `/events`.
 *
 * Derived, never hand-typed: a descriptor raised above this number makes the
 * parity test in `__tests__/worker-control-body-limits.test.ts` red instead of
 * silently re-creating the dead-guard defect this ticket closed.
 */
export const WORKER_CONTROL_BODY_LIMIT_BYTES =
  Math.max(
    ...WORKER_PROTOCOL_OPERATIONS
      .filter((op) => op !== "event_upload")
      .map(declaredBytes),
  ) + WORKER_CONTROL_BODY_HEADROOM_BYTES;

/**
 * Limit for `/events` alone.
 *
 * Kept off the shared prefix deliberately. `event_upload` is 4 MiB and the next
 * largest operation is 256 KiB, so a prefix-wide 4 MiB mount would hand a 64 KiB
 * operation a 4 MiB pre-auth parse buffer for no contractual reason. Express
 * matches these by registration order, so the specific mount is registered
 * before the prefix one.
 */
export const WORKER_CONTROL_EVENTS_BODY_LIMIT_BYTES =
  declaredBytes("event_upload") + WORKER_CONTROL_BODY_HEADROOM_BYTES;

/**
 * ★ `inflate: false` — closes a 1019.8 : 1 amplification, measured.
 *
 * body-parser defaults to `inflate: true`, and for a compressed body it SKIPS
 * the Content-Length pre-check (`read.js` sets `req.length` only for identity
 * encoding), so the limit bounds DECOMPRESSED bytes. Measured on this repo's
 * express 5.2.1: a 4,113-byte gzip body yielded 4,194,274 parsed bytes under a
 * 4 MiB limit.
 *
 * That matters here because authorization is checked INSIDE each handler, after
 * the body is parsed — `actorMiddleware` never rejects, `boardMutationGuard`
 * passes non-board actors through, and the only rate limiter runs inside the
 * poll handler after proof verification. So the parse is reachable
 * unauthenticated, and with inflate on, a few KB of gzip buys megabytes of heap.
 *
 * The legitimate worker never compresses: its transport sets exactly
 * content-type, authorization and the device-proof headers. So refusing
 * compressed bodies costs nothing real and makes the buffer bound 1:1 with
 * bandwidth actually spent.
 */
export const WORKER_CONTROL_INFLATE = false;
