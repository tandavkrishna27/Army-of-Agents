// The 429 back-off contract now lives in @armyofagents/shared so the UI can
// render the same wait/copy instead of hardcoding it (ui/src/api/client.ts
// discards response headers, so the card cannot read `Retry-After`).
// Re-exported here so the existing probe routes keep importing it alongside the
// slot primitives below.
export {
  ADAPTER_PROBE_RETRY_AFTER_SECONDS,
  ADAPTER_PROBE_BUSY_ERROR,
} from "@armyofagents/shared";

// Adapter probes can spawn a local CLI for tens of seconds. Keep one shared,
// in-process slot per company across every route that starts a probe. A
// multi-instance deployment would need a distributed lock instead.
const companiesWithProbeInFlight = new Set<string>();

export function tryAcquireAdapterProbeSlot(companyId: string): (() => void) | null {
  if (companiesWithProbeInFlight.has(companyId)) return null;

  companiesWithProbeInFlight.add(companyId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    companiesWithProbeInFlight.delete(companyId);
  };
}
