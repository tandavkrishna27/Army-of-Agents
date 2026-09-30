/**
 * Shared adapter-probe back-off contract.
 *
 * These live in shared — not in `server/src/services/adapter-probe-concurrency.ts`
 * where they started — because the CLIENT needs them too. A probe spawns a local
 * CLI for tens of seconds, so every route that starts one answers a second
 * concurrent request with `429` + `Retry-After`. The UI has to tell the founder
 * how long to wait and why, and `ui/src/api/client.ts` discards response headers,
 * so the card cannot read `Retry-After` off the response.
 *
 * Without a shared constant the UI would hardcode `30`, and the two would drift
 * silently the first time the server's back-off changed — the card would promise
 * a retry window the server does not honour.
 */

/** Seconds the server asks a 429'd caller to wait before retrying a probe. */
export const ADAPTER_PROBE_RETRY_AFTER_SECONDS = 30;

/** Founder-facing copy for a 429 from any probe route. */
export const ADAPTER_PROBE_BUSY_ERROR =
  "A connection test is already running for this company. Please wait for it to finish and retry.";

/**
 * How old a cached readiness verdict may be before it is worth re-probing.
 *
 * Shared for the same reason as the back-off constants above: the SERVER uses
 * it to decide what to re-probe, and the Settings -> Providers tab uses it to
 * decide which in-use providers to auto-refresh on open. Two copies would drift
 * and the tab would either storm the machine with probes or sit on verdicts the
 * server already considers stale.
 */
export const PROVIDER_READINESS_STALE_MS = 5 * 60_000;

/**
 * True when a cached probe is old enough to re-run.
 *
 * Every ambiguous input resolves to STALE, because the two directions are not
 * symmetric: a needless re-probe costs ~1-3s, while a wrongly-fresh row pins a
 * provider's status indefinitely and is exactly the false-green this feature
 * exists to prevent. So missing, unparseable AND future timestamps are all
 * stale — a future `testedAt` (clock skew, restored backup) would otherwise
 * read fresh forever, since `now - t` stays negative.
 */
export function isReadinessStale(
  testedAt: string | Date | null | undefined,
  thresholdMs: number = PROVIDER_READINESS_STALE_MS,
): boolean {
  if (!testedAt) return true;
  const t = testedAt instanceof Date ? testedAt.getTime() : Date.parse(testedAt);
  if (Number.isNaN(t)) return true;
  const age = Date.now() - t;
  if (age < 0) return true; // future timestamp — never trust it as fresh
  return age > thresholdMs;
}
